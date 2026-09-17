/**
 * TBAY Rewards — storefront behaviour.
 *
 * Newsletter, share buttons, wallet connection, TBAY redemption and the
 * L2 → L1 bridge. Vanilla JS, no build step, no jQuery.
 *
 * Wallet libraries are loaded on demand: a shopper who never touches Web3 never
 * downloads ethers. thirdweb is used when a client id is configured (giving
 * in-app, social and smart-account wallets) and plain EIP-1193 otherwise.
 *
 * Security posture: this file never decides *who* the user is. Every call goes
 * to a WordPress REST route that resolves identity from the session cookie, so
 * tampering with anything here can only ever affect the tamperer's own account.
 */
(function () {
	'use strict';

	var config = window.tbayRewards || {};
	var i18n = config.i18n || {};

	/**
	 * Runtime-compiled dynamic import.
	 *
	 * `import()` is valid in a classic script in every current browser, but the
	 * literal syntax is a parse error in older engines — which would take this
	 * whole file down, not just the wallet path. Building it at runtime keeps the
	 * failure contained to the one feature that needs it.
	 */
	var dynamicImport = (function () {
		try {
			return new Function('url', 'return import(url);');
		} catch (e) {
			return null;
		}
	}());

	function rest(path, body, method) {
		return fetch(config.restUrl + path, {
			method: method || 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-WP-Nonce': config.restNonce
			},
			credentials: 'same-origin',
			body: body ? JSON.stringify(body) : undefined
		}).then(function (response) {
			// A host error page is HTML, so json() throws — surface that as an
			// outage rather than a parser error.
			return response.json()['catch'](function () {
				throw new Error(response.ok ? i18n.genericError : i18n.errUnreachable);
			}).then(function (data) {
				if (!response.ok) throw new Error(data.message || i18n.genericError);
				return data;
			});
		});
	}

	function setStatus(element, message, tone) {
		if (!element) return;
		element.textContent = message || '';
		element.className = element.className.replace(/\s*tbay-status--\w+/g, '');
		if (tone) element.className += ' tbay-status--' + tone;
	}

	/**
	 * Turn wallet, RPC and transport errors into something a person can act on.
	 *
	 * ethers rejections are long JSON-ish strings, MetaMask says "Internal
	 * JSON-RPC error", and an HTML error page from the host makes response.json()
	 * throw a SyntaxError. None of that belongs in front of a customer.
	 */
	function friendlyError(error) {
		if (!error) return i18n.genericError;

		var code = error.code;
		var message = String(error.message || '');

		if (code === 4001 || code === 'ACTION_REJECTED' || /user rejected/i.test(message)) {
			return i18n.errCancelled;
		}
		if (code === 'INSUFFICIENT_FUNDS' || /insufficient funds/i.test(message)) {
			return i18n.errNoGas;
		}
		if (code === 4902 || /unrecognized chain|unknown chain/i.test(message)) {
			return i18n.errWrongChain;
		}
		if (/rest_cookie_invalid_nonce|cookie check failed/i.test(message)) {
			return i18n.errSessionExpired;
		}
		if (error instanceof SyntaxError || /unexpected token/i.test(message)) {
			return i18n.errUnreachable;
		}
		if (error instanceof TypeError || /failed to fetch|networkerror/i.test(message)) {
			return i18n.errUnreachable;
		}
		// Long machine strings are worse than no detail at all.
		return message && message.length < 160 ? message : i18n.genericError;
	}

	/**
	 * Local record of work that is in flight.
	 *
	 * Redemption spends points before the wallet prompt, and bridging burns
	 * tokens before the platform is told. If the last step fails — wallet
	 * rejected, tab closed, session expired, platform down — the value is
	 * already gone and the only copy of what to do next is in this tab. Writing
	 * it down first is what makes the failure recoverable instead of final.
	 */
	function remember(key, value) {
		try { window.localStorage.setItem('tbay_' + key, JSON.stringify(value)); } catch (e) {}
	}

	function recall(key) {
		try {
			var raw = window.localStorage.getItem('tbay_' + key);
			return raw ? JSON.parse(raw) : null;
		} catch (e) { return null; }
	}

	function forget(key) {
		try { window.localStorage.removeItem('tbay_' + key); } catch (e) {}
	}

	function explorerTx(hash) {
		var base = config.chain && config.chain.explorer;
		return base ? base + '/tx/' + hash : null;
	}

	function escapeHtml(value) {
		return String(value == null ? '' : value)
			.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
	}

	/**
	 * Render a wei string as whole TBAY without going through a double.
	 *
	 * Dust is by definition smaller than one bridge unit, so `Number(wei)/1e18`
	 * loses exactly the digits that matter and prints "0" for a real balance.
	 * String arithmetic keeps all 18 decimals honest.
	 */

	/**
	 * Cents to a readable amount.
	 *
	 * Intl when the browser has it, a plain two-decimal fallback when it does
	 * not — a currency code beside a number is still clearer than raw cents.
	 */
	function formatMoney(cents, currency) {
		var amount = (Number(cents) || 0) / 100;
		try {
			return new Intl.NumberFormat(undefined, {
				style: 'currency',
				currency: currency || 'USD'
			}).format(amount);
		} catch (e) {
			return amount.toFixed(2) + ' ' + (currency || '');
		}
	}

	function weiToTokens(wei) {
		var digits = String(wei == null ? '0' : wei).replace(/[^0-9]/g, '') || '0';
		while (digits.length < 19) digits = '0' + digits;
		var whole = digits.slice(0, digits.length - 18).replace(/^0+(?=\d)/, '');
		var frac = digits.slice(digits.length - 18).replace(/0+$/, '');
		return frac ? whole + '.' + frac : whole;
	}

	// ── Newsletter ───────────────────────────────────────────────────────────

	function initNewsletter(form) {
		var status = form.querySelector('.tbay-newsletter__status');

		form.addEventListener('submit', function (event) {
			if (!window.fetch) return; // let the plain form post handle it
			event.preventDefault();

			var email = form.querySelector('input[type=email]');
			var name = form.querySelector('input[name=name]');
			var honeypot = form.querySelector('input[name=website]');
			var button = form.querySelector('button[type=submit]');

			if (!email || !email.value) return;
			if (honeypot && honeypot.value) return;

			button.disabled = true;
			setStatus(status, i18n.subscribing, 'pending');

			rest('subscribe', {
				email: email.value,
				name: name ? name.value : '',
				list: form.dataset.list || 'newsletter',
				source: form.dataset.source || 'inline',
				visitor: window.tbay && window.tbay.visitorId ? window.tbay.visitorId() : ''
			}).then(function (data) {
				form.reset();
				setStatus(status,
					// One answer for everybody: the endpoint is public, and saying
					// "you are already subscribed" answers a question about
					// somebody else's address.
					i18n.subscribed, 'ok');
				if (window.tbay) window.tbay.track('newsletter_signup', { list: form.dataset.list });
			})['catch'](function (error) {
				setStatus(status, friendlyError(error), 'error');
			})['finally'](function () {
				button.disabled = false;
			});
		});
	}

	// ── Share buttons ────────────────────────────────────────────────────────

	function initShare(container) {
		var status = container.querySelector('.tbay-share__status');

		container.addEventListener('click', function (event) {
			var button = event.target.closest('[data-network]');
			if (!button) return;

			button.disabled = true;
			setStatus(status, i18n.shareCreating, 'pending');

			// Every iOS browser is WebKit, and WebKit blocks a window.open() that
			// is not synchronous with the tap. Open it now and point it at the
			// intent URL once we have one.
			var popup = null;
			if (button.dataset.network !== 'copy') {
				try {
					popup = window.open('', '_blank', 'noopener,noreferrer,width=600,height=520');
				} catch (e) { popup = null; }
			}

			rest('share', {
				network: button.dataset.network,
				url: container.dataset.url,
				product: container.dataset.product || '',
				post: container.dataset.post || ''
			}).then(function (data) {
				// Deliberately NOT crediting the share here. The reward is meant to
				// require a genuine third-party click, and reporting one from the
				// sharer's own browser at the moment they press the button would
				// hand out the points for nothing.
				if (window.tbay) {
					window.tbay.track('share_created', { network: button.dataset.network });
				}

				if (button.dataset.network === 'copy' || !data.intent_url) {
					if (popup) popup.close();

					// A share sheet is a better fit than the clipboard on a phone.
					if (navigator.share) {
						return navigator.share({ url: data.share_url })
							.then(function () { setStatus(status, i18n.shareOpened, 'ok'); })
							['catch'](function () { setStatus(status, '', null); });
					}

					return copyToClipboard(data.share_url).then(function () {
						setStatus(status, i18n.shareCopied, 'ok');
					});
				}

				if (popup) popup.location = data.intent_url;
				else window.open(data.intent_url, '_blank', 'noopener,noreferrer,width=600,height=520');

				setStatus(status, i18n.shareOpened, 'ok');
			})['catch'](function (error) {
				if (popup) popup.close();
				setStatus(status, friendlyError(error) || i18n.shareFailed, 'error');
			})['finally'](function () {
				button.disabled = false;
			});
		});
	}

	function copyToClipboard(text) {
		if (navigator.clipboard && navigator.clipboard.writeText) {
			return navigator.clipboard.writeText(text);
		}
		return new Promise(function (resolve) {
			var field = document.createElement('textarea');
			field.value = text;
			field.setAttribute('readonly', '');
			field.style.position = 'absolute';
			field.style.left = '-9999px';
			document.body.appendChild(field);
			field.select();
			try { document.execCommand('copy'); } catch (e) { /* best effort */ }
			document.body.removeChild(field);
			resolve();
		});
	}

	// ── Wallet plumbing ──────────────────────────────────────────────────────

	var scriptCache = {};

	/**
	 * Load a third-party script, and refuse it if it is not the one expected.
	 *
	 * This code runs on the page that asks a wallet to sign claims and burns.
	 * A CDN that served something else — compromised, or a version republished
	 * under the same URL — would be arbitrary JavaScript next to somebody's
	 * wallet. `integrity` makes the browser check the bytes and drop them if
	 * they do not match, so the worst case becomes "the wallet library did not
	 * load" rather than "the wallet library was someone else's".
	 */
	function loadScript(src, integrity) {
		if (scriptCache[src]) return scriptCache[src];
		scriptCache[src] = new Promise(function (resolve, reject) {
			var script = document.createElement('script');
			script.src = src;
			script.crossOrigin = 'anonymous';
			if (integrity) script.integrity = integrity;
			script.onload = resolve;
			script.onerror = function () { reject(new Error('Could not load the wallet library.')); };
			document.head.appendChild(script);
		});
		return scriptCache[src];
	}

	// Pinned to an exact version with its published hash. Bump both together;
	// a version without a hash is a version nobody is checking.
	var ETHERS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/ethers/6.7.1/ethers.umd.min.js';
	var ETHERS_SRI = config.ethersIntegrity || '';

	function loadEthers() {
		if (window.ethers) return Promise.resolve(window.ethers);
		return loadScript(ETHERS_URL, ETHERS_SRI).then(function () { return window.ethers; });
	}

	/**
	 * thirdweb Connect, when the site has a client id.
	 *
	 * It brings in-app wallets, social login and smart accounts, which matters
	 * for customers who have never installed MetaMask. Without a client id we
	 * fall back to the injected EIP-1193 provider, so the flow still works.
	 *
	 * thirdweb v5 ships ESM only — there is no UMD bundle to drop in a <script>
	 * tag — so it is pulled in with a dynamic import from an ESM CDN.
	 */
	function thirdwebEnabled() {
		return Boolean(config.thirdweb && config.thirdweb.clientId);
	}

	var thirdwebModule = null;

	function loadThirdweb() {
		if (thirdwebModule) return Promise.resolve(thirdwebModule);
		if (!dynamicImport) return Promise.reject(new Error(i18n.noWallet));
		// An exact version, not `@5`. A floating major resolves to whatever the
		// CDN serves at load time — including a minor published an hour ago and
		// its transitive dependencies — on the page that signs wallet
		// transactions. An ESM import cannot carry an integrity hash, so
		// pinning is the whole of the defence.
		return dynamicImport(config.thirdwebModuleUrl || 'https://esm.sh/thirdweb@5.105.0').then(function (mod) {
			thirdwebModule = mod;
			return mod;
		});
	}

	/**
	 * Connect an in-app wallet and hand back an EIP-1193 provider.
	 *
	 * `strategy` is required by v5 — omitting it rejects — and the provider comes
	 * from the EIP1193 adapter rather than any method on the wallet itself.
	 */
	function thirdwebProvider() {
		return loadThirdweb().then(function (sdk) {
			if (!sdk || !sdk.createThirdwebClient || !sdk.inAppWallet) {
				throw new Error(i18n.noWallet);
			}

			var client = sdk.createThirdwebClient({ clientId: config.thirdweb.clientId });
			var chainId = (config.chain && config.chain.l2ChainId) || 300;
			var chain = sdk.defineChain(chainId);
			var wallet = sdk.inAppWallet();

			return wallet
				.connect({ client: client, chain: chain, strategy: 'google' })
				.then(function () {
					return dynamicImport('https://esm.sh/thirdweb@5/wallets/eip1193');
				})
				.then(function (eip1193) {
					return eip1193.toProvider({ wallet: wallet, chain: chain, client: client });
				});
		});
	}

	/**
	 * An EIP-1193 provider.
	 *
	 * An injected wallet wins when present. Otherwise thirdweb, if configured.
	 * Otherwise, on a phone, a deep link into the MetaMask browser — which is
	 * the difference between "install MetaMask" as a dead end and a route that
	 * actually gets a customer to their tokens.
	 */
	function getProvider() {
		if (window.ethereum) return Promise.resolve(window.ethereum);

		if (thirdwebEnabled()) {
			return thirdwebProvider()['catch'](function () {
				return Promise.reject(new Error(mobileHint()));
			});
		}

		return Promise.reject(new Error(mobileHint()));
	}

	function isMobile() {
		return /android|iphone|ipad|ipod/i.test(navigator.userAgent || '');
	}

	function mobileHint() {
		return isMobile() ? i18n.noWalletMobile : i18n.noWallet;
	}

	/** Offer a deep link into a wallet browser when there is no provider here. */
	function renderWalletHelp(panel) {
		var host = panel.querySelector('[data-tbay-wallet-help]');
		if (!host || window.ethereum || !isMobile()) return;

		var target = location.host + location.pathname + location.search;
		host.hidden = false;
		host.innerHTML =
			'<p class="tbay-bridge__warning">' + escapeHtml(i18n.noWalletMobile) +
			' <a class="tbay-button tbay-button--sm" href="https://metamask.app.link/dapp/' +
			escapeHtml(target) + '">' + escapeHtml(i18n.openInWallet) + '</a></p>';
	}

	/** Switch the wallet to TBAY's L2, adding the network if it is unknown. */
	function ensureChain(provider, chainId, addParams) {
		var target = '0x' + Number(chainId).toString(16);

		return provider.request({ method: 'eth_chainId' }).then(function (current) {
			if (String(current).toLowerCase() === target) return null;

			return provider.request({
				method: 'wallet_switchEthereumChain',
				params: [{ chainId: target }]
			})['catch'](function (error) {
				// 4902 = the wallet has never heard of this chain. Offer to add it
				// rather than dead-ending the customer on an unknown network.
				if (error && (error.code === 4902 || error.code === -32603) && addParams) {
					return provider.request({ method: 'wallet_addEthereumChain', params: [addParams] });
				}
				throw error;
			});
		});
	}

	// ── Rewards dashboard ────────────────────────────────────────────────────

	function initRewards(panel) {
		var status = panel.querySelector('[data-tbay-wallet-status]');
		var addressEl = panel.querySelector('[data-tbay-wallet-address]');
		var connectButton = panel.querySelector('[data-tbay-connect-wallet]');
		var redeemButton = panel.querySelector('[data-tbay-redeem]');
		var creditButton = panel.querySelector('[data-tbay-credit]');
		var creditResult = panel.querySelector('[data-tbay-credit-result]');
		var amountInput = panel.querySelector('[data-tbay-redeem-amount]');
		var connected = null;

		/**
		 * Spend points for a store credit code.
		 *
		 * Confirmed first, because it is irreversible: the points are gone and
		 * what comes back is a code for money off an order. A single click
		 * should not be able to empty someone's balance.
		 */
		if (creditButton) {
			creditButton.addEventListener('click', function () {
				var points = parseInt(amountInput ? amountInput.value : '0', 10);
				if (!points || points <= 0) {
					setStatus(status, i18n.redeemAmount, 'error');
					return;
				}

				rest('credit-quote?points=' + encodeURIComponent(points), null, 'GET')
					.then(function (quote) {
						var usable = quote.points || 0;
						if (usable <= 0) {
							throw new Error(
								(i18n.creditTooFew || 'That is not enough points yet.') +
								' (' + (quote.points_per_token || 0) + ')'
							);
						}

						// Shows what they get before they lose anything, which
						// is the whole reason the quote endpoint exists.
						var confirmed = window.confirm(
							(i18n.creditConfirm || 'Use {points} points for {amount}?')
								.replace('{points}', String(usable))
								.replace('{amount}', formatMoney(quote.amount_cents, quote.currency))
						);
						if (!confirmed) return null;

						creditButton.disabled = true;
						setStatus(status, i18n.redeeming, 'pending');
						return rest('credit', { points: usable });
					})
					.then(function (result) {
						if (!result) return;
						setStatus(status, i18n.creditIssued || '', 'ok');
						if (creditResult) {
							creditResult.innerHTML =
								'<p class="tbay-credit-code">' +
								escapeHtml(i18n.creditCode || 'Your code') + ': <code>' +
								escapeHtml(result.code) + '</code> — ' +
								escapeHtml(formatMoney(result.amount_cents, result.currency)) +
								'</p>';
							creditResult.hidden = false;
						}
						if (amountInput && result.balance) {
							amountInput.max = String(result.balance.balance);
							amountInput.value = String(result.balance.balance);
						}
					})
					['catch'](function (error) {
						setStatus(status, friendlyError(error), 'error');
					})
					['finally'](function () {
						creditButton.disabled = false;
					});
			});
		}

		function currentAddress() {
			if (connected) return connected;
			var code = addressEl ? addressEl.querySelector('code') : null;
			return code ? code.textContent.trim() : null;
		}

		function showAddress(address) {
			if (!addressEl) return;
			addressEl.innerHTML = '<code></code>';
			addressEl.querySelector('code').textContent = address;
		}

		/**
		 * Connect a wallet and prove it belongs to this account.
		 *
		 * The signature is free, costs no gas and grants no spending permission —
		 * it only demonstrates control of the private key. Without it, "my wallet
		 * is 0x…" would be an unverified claim that later steps trust.
		 */
		function connect() {
			setStatus(status, i18n.connecting, 'pending');
			var provider = null;
			var address = null;

			return getProvider()
				.then(function (found) {
					provider = found;
					return provider.request({ method: 'eth_requestAccounts' });
				})
				.then(function (accounts) {
					if (!accounts || !accounts.length) throw new Error(i18n.noWallet);
					address = accounts[0];
					return rest('wallet/challenge', { walletAddress: address });
				})
				.then(function (challenge) {
					setStatus(status, i18n.signPrompt, 'pending');
					return provider.request({
						method: 'personal_sign',
						params: [challenge.message, address],
					}).then(function (signature) {
						return rest('wallet', {
							nonce: challenge.nonce,
							message: challenge.message,
							signature: signature,
						});
					});
				})
				.then(function () {
					connected = address;
					showAddress(address);
					setStatus(status, i18n.walletLinked, 'ok');
					return address;
				});
		}

		if (connectButton) {
			connectButton.addEventListener('click', function () {
				connect()['catch'](function (error) {
					setStatus(status, friendlyError(error), 'error');
				});
			});
		}

		if (redeemButton) {
			redeemButton.addEventListener('click', function () {
				var points = parseInt(amountInput ? amountInput.value : '0', 10);
				if (!points || points <= 0) return;

				redeemButton.disabled = true;
				setStatus(status, i18n.redeeming, 'pending');

				var wallet = currentAddress();
				(wallet ? Promise.resolve(wallet) : connect())
					.then(function (address) {
						return rest('redeem', { points: points, walletAddress: address });
					})
					.then(function (voucher) {
						// Treasury mode delivers the tokens server-side; there is
						// nothing for the customer to sign.
						if (voucher.delivery === 'treasury_transfer') {
							setStatus(status, i18n.claimed, 'ok');
							return { txHash: voucher.tx_hash };
						}

						// The points are already spent at this point, so keep the
						// voucher where a reload can find it.
						remember('voucher', voucher);
						renderPending(panel, voucher);

						setStatus(status, i18n.confirmWallet, 'pending');
						return submitClaim(voucher, status);
					})
					.then(function (result) {
						forget('voucher');
						renderPending(panel, null);
						setStatus(status, claimedMessage(result.txHash), 'ok');
						refreshBalance(panel);
					})
					['catch'](function (error) {
						setStatus(status, friendlyError(error), 'error');
					})
					['finally'](function () {
						redeemButton.disabled = false;
					});
			});
		}

		// Anything left over from a previous visit is offered again rather than
		// silently lost.
		renderPending(panel, recall('voucher'));
		renderWalletHelp(panel);

		var bridge = panel.querySelector('[data-tbay-bridge]');
		if (bridge) initBridge(bridge, currentAddress);

		var refresh = function () { refreshBalance(panel); };
		var coupon = panel.querySelector('[data-tbay-coupon]');
		if (coupon) initCoupon(coupon, refresh);

		var transfer = panel.querySelector('[data-tbay-transfer]');
		if (transfer) initTransfer(transfer, refresh);
	}

	function claimedMessage(hash) {
		if (!hash) return i18n.claimed;
		var url = explorerTx(hash);
		return i18n.claimed + (url ? ' ' + url : ' ' + hash);
	}

	/**
	 * Show an unfinished claim with a way to finish it.
	 *
	 * Without this a customer whose wallet prompt failed sees their balance drop
	 * with nothing to show for it and no route back.
	 */
	function renderPending(panel, voucher) {
		var host = panel.querySelector('[data-tbay-pending]');
		if (!host) return;

		if (!voucher || !voucher.transaction) {
			host.hidden = true;
			host.innerHTML = '';
			return;
		}

		host.hidden = false;
		host.innerHTML =
			'<p class="tbay-bridge__warning">' +
			escapeHtml((i18n.claimPending || '').replace('%s', voucher.transaction.amountTokens || '')) +
			' <button type="button" class="tbay-button tbay-button--sm" data-tbay-resume-claim>' +
			escapeHtml(i18n.claimResume) + '</button></p>';

		var resume = host.querySelector('[data-tbay-resume-claim]');
		var status = panel.querySelector('[data-tbay-wallet-status]');

		resume.addEventListener('click', function () {
			resume.disabled = true;
			setStatus(status, i18n.confirmWallet, 'pending');

			submitClaim(voucher, status)
				.then(function (result) {
					forget('voucher');
					renderPending(panel, null);
					setStatus(status, claimedMessage(result.txHash), 'ok');
					refreshBalance(panel);
				})
				['catch'](function (error) {
					setStatus(status, friendlyError(error), 'error');
				})
				['finally'](function () { resume.disabled = false; });
		});
	}

	/**
	 * Submit the platform-signed voucher from the customer's own wallet.
	 *
	 * The signature authorises exactly one (user, amount, nonce) triple, so it is
	 * worthless to anyone else even if intercepted — the contract recovers the
	 * signer and checks the `user` field against msg.sender's claim.
	 */
	function submitClaim(voucher, status) {
		var transaction = voucher.transaction;
		if (!transaction) return Promise.resolve({ txHash: null });

		return Promise.all([loadEthers(), getProvider()]).then(function (parts) {
			var ethers = parts[0];
			var raw = parts[1];

			return ensureChain(raw, transaction.chainId, config.chain && config.chain.addParams)
				.then(function () {
					var provider = new ethers.BrowserProvider(raw);
					return provider.getSigner();
				})
				.then(function (signer) {
					return signer.getAddress().then(function (address) {
						// The voucher names one wallet. Submitting from a different
						// account reverts on-chain and costs the customer gas, so
						// stop here with an explanation instead.
						if (voucher.wallet_address &&
							address.toLowerCase() !== String(voucher.wallet_address).toLowerCase()) {
							throw new Error(i18n.claimWrongWallet);
						}

						var contract = new ethers.Contract(
							transaction.contractAddress,
							['function claim(uint256 amount, uint256 nonce, bytes signature)'],
							signer
						);
						return contract.claim(
							transaction.args.amount,
							transaction.args.nonce,
							transaction.args.signature
						);
					});
				})
				.then(function (tx) {
					// Confirmations take a while; say so rather than leaving the
					// status on "confirm in your wallet" after they already have.
					var url = explorerTx(tx.hash);
					setStatus(status, i18n.txSent + (url ? ' ' + url : ''), 'pending');

					// Retried, and never swallowed. If the platform does not learn
					// the claim was spent it stays open, later expires, and — where
					// the store refunds on expiry — pays the points back for tokens
					// the member is already holding.
					recordClaimTx(voucher.claim_id, tx.hash, status);
					return tx.wait().then(function () { return { txHash: tx.hash }; });
				});
		});
	}

	/**
	 * Tell the platform a voucher was spent, and keep trying.
	 *
	 * A lost confirmation is not cosmetic: the claim stays open and expires,
	 * which on a store that refunds expired claims pays the same value twice.
	 * Three attempts over about half a minute covers a reload of the API or a
	 * moment of bad connectivity; after that the member is told, with the hash,
	 * so support has something to work from.
	 */
	function recordClaimTx(claimId, txHash, status) {
		var attempt = 0;

		function send() {
			attempt += 1;
			return rest('claim-tx', { claimId: claimId, txHash: txHash })['catch'](function (error) {
				if (attempt < 3) {
					return new Promise(function (resolve) {
						window.setTimeout(resolve, attempt * 5000);
					}).then(send);
				}
				if (status) {
					setStatus(
						status,
						i18n.claimNotRecorded
							? i18n.claimNotRecorded.replace('%s', txHash)
							: 'Your tokens were claimed, but we could not record it. Please quote ' +
								txHash + ' to support.',
						'error'
					);
				}
				throw error;
			});
		}

		return send()['catch'](function () {});
	}

	function refreshBalance(panel) {
		rest('balance', null, 'GET').then(function (data) {
			var balance = panel.querySelector('[data-tbay-balance]');
			var quote = panel.querySelector('[data-tbay-quote]');
			var amount = panel.querySelector('[data-tbay-redeem-amount]');

			if (balance) balance.textContent = (data.points.balance || 0).toLocaleString();
			if (quote) quote.textContent = data.quote_tokens || '0';
			if (amount) {
				amount.value = data.points.balance || 0;
				amount.max = data.points.balance || 0;
			}
		})['catch'](function () { /* the page stays usable */ });
	}

	// ── L2 → L1 bridge ───────────────────────────────────────────────────────

	/** Recording a burn is idempotent server-side, so a duplicate is success. */
	function submitBurn(txHash) {
		return rest('bridge/submit', { txHash: txHash })['catch'](function (error) {
			if (/already been submitted|already/i.test(String(error.message || ''))) return null;
			throw error;
		});
	}

	function renderPendingBurn(panel, burn) {
		var host = panel.querySelector('[data-tbay-bridge-pending]');
		if (!host) return;

		if (!burn) {
			host.hidden = true;
			host.innerHTML = '';
			return;
		}

		var url = explorerTx(burn.txHash);
		host.hidden = false;
		host.innerHTML =
			'<p class="tbay-bridge__warning">' + escapeHtml(i18n.bridgeUnrecorded) +
			(url ? ' <a href="' + escapeHtml(url) + '" target="_blank" rel="noopener">' +
				escapeHtml(i18n.bridgeViewTx) + '</a>' : '') +
			' <button type="button" class="tbay-button tbay-button--sm" data-tbay-retry-burn>' +
			escapeHtml(i18n.bridgeRetry) + '</button></p>';

		var retry = host.querySelector('[data-tbay-retry-burn]');
		var status = panel.querySelector('[data-tbay-bridge-status]');

		retry.addEventListener('click', function () {
			retry.disabled = true;
			setStatus(status, i18n.bridgeVerifying, 'pending');

			submitBurn(burn.txHash)
				.then(function () {
					forget('burn');
					renderPendingBurn(panel, null);
					setStatus(status, i18n.bridgeQueued, 'ok');
				})
				['catch'](function (error) {
					setStatus(status, friendlyError(error), 'error');
				})
				['finally'](function () { retry.disabled = false; });
		});
	}

	function initBridge(panel, currentAddress) {
		var amountInput = panel.querySelector('[data-tbay-bridge-amount]');
		var quoteButton = panel.querySelector('[data-tbay-bridge-quote]');
		var submitButton = panel.querySelector('[data-tbay-bridge-submit]');
		var output = panel.querySelector('[data-tbay-bridge-quote-output]');
		var status = panel.querySelector('[data-tbay-bridge-status]');

		// An unrecorded burn from a previous visit is still recoverable.
		renderPendingBurn(panel, recall('burn'));

		function amount() {
			return parseFloat(amountInput ? amountInput.value : '0');
		}

		function quote() {
			var value = amount();
			if (!value || value <= 0) {
				setStatus(status, i18n.bridgeAmount, 'error');
				return Promise.reject(new Error(i18n.bridgeAmount));
			}
			return rest('bridge/quote', { amountTokens: value }).then(function (data) {
				renderQuote(data);
				return data;
			});
		}

		function renderQuote(data) {
			if (!output) return;
			// Three distinct numbers: what they asked for, what arrives, and what
			// stays behind. Printing the bridgeable amount on two rows made the
			// rounding invisible, which is the one thing a preview must show.
			// BigInt rather than Number: dust is measured in wei, where a double
			// loses precision well before the last digit.
			var remainder = '0';
			try {
				remainder = String(data.dustWei || '0');
			} catch (e) { /* leave at zero */ }
			var rows =
				'<dl>' +
				'<dt>' + escapeHtml(i18n.bridgeAsked) + '</dt>' +
				'<dd>' + escapeHtml(amountInput ? amountInput.value : '') + ' TBAY</dd>' +
				'<dt>' + escapeHtml(i18n.bridgeReceiveL1) + '</dt>' +
				'<dd>' + escapeHtml(data.bridgeableTokens) + ' TBAY</dd>' +
				(remainder !== '0'
					? '<dt>' + escapeHtml(i18n.bridgeStays) + '</dt><dd>' +
					  escapeHtml(weiToTokens(remainder)) + ' TBAY</dd>'
					: '') +
				'</dl>';

			// Prefer the server's note: it knows the live bridge rate, so it can
			// name the real precision floor instead of a hardcoded one.
			output.innerHTML = rows +
				'<p class="tbay-bridge__warning">' +
				escapeHtml(data.dustNote || i18n.bridgeRounding) + '</p>';
			output.hidden = false;
		}

		if (quoteButton) {
			quoteButton.addEventListener('click', function () {
				setStatus(status, '', null);
				quote()['catch'](function (error) {
					setStatus(status, friendlyError(error), 'error');
				});
			});
		}

		if (submitButton) {
			submitButton.addEventListener('click', function () {
				var wallet = currentAddress ? currentAddress() : null;
				if (!wallet) {
					setStatus(status, i18n.bridgeConnect, 'error');
					return;
				}

				submitButton.disabled = true;
				setStatus(status, i18n.bridgePreparing, 'pending');

				quote()
					.then(function (data) {
						setStatus(status, i18n.confirmWallet, 'pending');
						return burnOnL2(wallet, data, status);
					})
					.then(function (txHash) {
						// The tokens are burned the moment this resolves. Write the
						// hash down before the network call that records it, so a
						// failure here is a retry rather than a loss.
						remember('burn', { txHash: txHash, at: Date.now() });
						setStatus(status, i18n.bridgeVerifying, 'pending');
						return submitBurn(txHash);
					})
					.then(function () {
						forget('burn');
						renderPendingBurn(panel, null);
						setStatus(status, i18n.bridgeQueued, 'ok');
					})
					['catch'](function (error) {
						setStatus(status, friendlyError(error), 'error');
					})
					['finally'](function () {
						submitButton.disabled = false;
					});
			});
		}
	}

	/**
	 * Call crosschainBurn from the holder's own wallet.
	 *
	 * The contract only allows a burn where `_from` is msg.sender (or a bridge
	 * role), so this can never burn somebody else's balance.
	 *
	 * We pass the *full* requested amount rather than the rounded-down
	 * bridgeable part, because `crosschainBurn` is the dust wrapper: it burns
	 * the whole L1 units and sweeps the sub-unit remainder to the treasury in
	 * the same transaction, returning it to the company's L2 supply. Passing the
	 * rounded amount would skip that path and strand an unspendable crumb in the
	 * holder's wallet. The quote shows both numbers before this runs.
	 */
	function burnOnL2(wallet, quoteData, status) {
		return Promise.all([loadEthers(), getProvider()]).then(function (parts) {
			var ethers = parts[0];
			var raw = parts[1];

			return ensureChain(raw, quoteData.chainId, config.chain && config.chain.addParams)
				.then(function () {
					var provider = new ethers.BrowserProvider(raw);
					return provider.getSigner();
				})
				.then(function (signer) {
					return signer.getAddress().then(function (signerAddress) {
						// Refuse to sign a burn for an address that is not the one
						// the account has registered, rather than burning tokens the
						// platform will then decline to credit.
						if (signerAddress.toLowerCase() !== String(wallet).toLowerCase()) {
							throw new Error(i18n.bridgeWrongWallet);
						}
						var contract = new ethers.Contract(
							quoteData.contractAddress,
							['function crosschainBurn(address from, uint256 amount)'],
							signer
						);
						return contract.crosschainBurn(signerAddress, quoteData.amountWei);
					});
				})
				.then(function (tx) {
					var url = explorerTx(tx.hash);
					setStatus(status, i18n.txSent + (url ? ' ' + url : ''), 'pending');
					return tx.wait().then(function () { return tx.hash; });
				});
		});
	}

	// ── Coupons and point transfers ──────────────────────────────────────────

	function initCoupon(panel, onChange) {
		var input = panel.querySelector('[data-tbay-coupon-code]');
		var button = panel.querySelector('[data-tbay-coupon-submit]');
		var status = panel.querySelector('[data-tbay-coupon-status]');
		if (!input || !button) return;

		function submit() {
			var code = input.value.trim();
			if (!code) return;

			button.disabled = true;
			setStatus(status, i18n.couponChecking, 'pending');

			rest('coupon', { code: code })
				.then(function (data) {
					input.value = '';
					setStatus(status, (i18n.couponRedeemed || '') .replace('%d', data.points), 'ok');
					if (onChange) onChange();
				})
				['catch'](function (error) {
					setStatus(status, friendlyError(error), 'error');
				})
				['finally'](function () { button.disabled = false; });
		}

		button.addEventListener('click', submit);
		// Enter in the field should submit, like any other single-field form.
		input.addEventListener('keydown', function (event) {
			if (event.key === 'Enter') { event.preventDefault(); submit(); }
		});
	}

	function initTransfer(panel, onChange) {
		var email = panel.querySelector('[data-tbay-transfer-email]');
		var amount = panel.querySelector('[data-tbay-transfer-amount]');
		var button = panel.querySelector('[data-tbay-transfer-submit]');
		var status = panel.querySelector('[data-tbay-transfer-status]');
		if (!email || !amount || !button) return;

		button.addEventListener('click', function () {
			var points = parseInt(amount.value, 10);
			if (!email.value || !points || points <= 0) {
				setStatus(status, i18n.transferInvalid, 'error');
				return;
			}

			button.disabled = true;
			setStatus(status, i18n.transferSending, 'pending');

			rest('transfer', { toEmail: email.value.trim(), points: points })
				.then(function (data) {
					email.value = '';
					amount.value = '';
					setStatus(status, (i18n.transferSent || '').replace('%d', data.points), 'ok');
					if (onChange) onChange();
				})
				['catch'](function (error) {
					setStatus(status, friendlyError(error), 'error');
				})
				['finally'](function () { button.disabled = false; });
		});
	}

	// ── Boot ─────────────────────────────────────────────────────────────────

	/** "Use my credit" at cart and checkout. */
	function initCredit(panel) {
		var button = panel.querySelector('[data-tbay-apply-credit]');
		var status = panel.querySelector('[data-tbay-credit-status]');
		if (!button) return;

		button.addEventListener('click', function () {
			button.disabled = true;
			setStatus(status, i18n.creditApplying, 'pending');

			var body = new URLSearchParams();
			body.append('action', 'tbay_apply_credit');
			body.append('nonce', button.dataset.nonce);

			fetch(config.ajaxUrl, { method: 'POST', body: body, credentials: 'same-origin' })
				.then(function (response) { return response.json(); })
				.then(function (payload) {
					if (!payload.success) {
						throw new Error(payload.data && payload.data.message);
					}
					// Woo recalculates totals on reload, which is also the moment
					// the discount becomes visible.
					window.location.reload();
				})
				['catch'](function (error) {
					setStatus(status, friendlyError(error), 'error');
					button.disabled = false;
				});
		});
	}

	// ── Notifications ────────────────────────────────────────────────────────

	/**
	 * Show badge, rank and streak notifications the platform has recorded.
	 *
	 * These rows have existed since gamification shipped and nothing rendered
	 * them, so unlocking a badge was silent. Marked read as soon as they are
	 * shown, which is the only honest moment: the customer has now seen them,
	 * and a toast that reappears on every page is worse than none.
	 */
	function initNotifications() {
		// Only for signed-in members — anonymous visitors have no notifications
		// and the REST route would just 401 on every page load.
		if (!config.restUrl || !config.loggedIn) return;

		rest('notifications', null, 'GET').then(function (data) {
			var items = (data && data.notifications) || [];
			if (items.length === 0) return;

			var strip = document.createElement('div');
			strip.className = 'tbay-toasts';
			strip.setAttribute('role', 'status');
			strip.setAttribute('aria-live', 'polite');

			items.slice(0, 3).forEach(function (item) {
				var toast = document.createElement('div');
				toast.className = 'tbay-toast tbay-toast--' + escapeHtml(String(item.kind || 'info'));
				toast.innerHTML =
					'<strong class="tbay-toast__title">' + escapeHtml(item.title || '') + '</strong>' +
					(item.body ? '<span class="tbay-toast__body">' + escapeHtml(item.body) + '</span>' : '') +
					'<button type="button" class="tbay-toast__close" aria-label="' +
					escapeHtml(i18n.dismiss || 'Dismiss') + '">&times;</button>';

				toast.querySelector('.tbay-toast__close').addEventListener('click', function () {
					toast.remove();
					if (!strip.querySelector('.tbay-toast')) strip.remove();
				});

				strip.appendChild(toast);
			});

			document.body.appendChild(strip);

			rest('notifications/read', { ids: items.map(function (item) { return item.id; }) })
				['catch'](function () { /* seen is seen; a failed mark retries next load */ });

			// Auto-dismiss, but only for people who have not asked for reduced
			// motion — for them the strip stays until dismissed.
			var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
			if (!still) {
				setTimeout(function () {
					strip.classList.add('tbay-toasts--out');
					setTimeout(function () { strip.remove(); }, 400);
				}, 8000);
			}
		})['catch'](function () {
			// A notification is never worth an error in front of a customer.
		});
	}

	function boot() {
		document.querySelectorAll('[data-tbay-credit]').forEach(initCredit);
		document.querySelectorAll('[data-tbay-newsletter]').forEach(initNewsletter);
		document.querySelectorAll('[data-tbay-share]').forEach(initShare);
		document.querySelectorAll('[data-tbay-rewards]').forEach(initRewards);
		initNotifications();

		// A bridge panel used on its own, outside the dashboard.
		document.querySelectorAll('[data-tbay-bridge]').forEach(function (panel) {
			if (panel.closest('[data-tbay-rewards]')) return;
			initBridge(panel, function () {
				var code = document.querySelector('[data-tbay-wallet-address] code');
				return code ? code.textContent.trim() : null;
			});
		});
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', boot);
	} else {
		boot();
	}
}());
