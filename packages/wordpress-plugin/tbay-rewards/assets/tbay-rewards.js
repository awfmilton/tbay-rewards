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
					data.status === 'already_subscribed' ? i18n.alreadyMember : i18n.subscribed, 'ok');
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

	function loadScript(src) {
		if (scriptCache[src]) return scriptCache[src];
		scriptCache[src] = new Promise(function (resolve, reject) {
			var script = document.createElement('script');
			script.src = src;
			script.crossOrigin = 'anonymous';
			script.onload = resolve;
			script.onerror = function () { reject(new Error('Could not load the wallet library.')); };
			document.head.appendChild(script);
		});
		return scriptCache[src];
	}

	function loadEthers() {
		if (window.ethers) return Promise.resolve(window.ethers);
		return loadScript('https://cdnjs.cloudflare.com/ajax/libs/ethers/6.7.1/ethers.umd.min.js')
			.then(function () { return window.ethers; });
	}

	/**
	 * thirdweb Connect, when the site has a client id.
	 *
	 * It brings in-app wallets, social login and smart accounts, which matters
	 * for customers who have never installed MetaMask. When it is not configured
	 * we fall back to the injected EIP-1193 provider, so the flow still works.
	 */
	function thirdwebEnabled() {
		return Boolean(config.thirdweb && config.thirdweb.clientId);
	}

	function loadThirdweb() {
		if (window.thirdweb) return Promise.resolve(window.thirdweb);
		return loadScript('https://cdn.jsdelivr.net/npm/thirdweb@5/dist/thirdweb.umd.min.js')
			.then(function () { return window.thirdweb; });
	}

	/** An EIP-1193 provider, from thirdweb when available and injected otherwise. */
	function getProvider() {
		if (window.ethereum) return Promise.resolve(window.ethereum);

		if (thirdwebEnabled()) {
			return loadThirdweb().then(function (sdk) {
				if (!sdk || !sdk.createThirdwebClient) throw new Error(i18n.noWallet);
				var client = sdk.createThirdwebClient({ clientId: config.thirdweb.clientId });
				var wallet = sdk.inAppWallet ? sdk.inAppWallet() : null;
				if (!wallet) throw new Error(i18n.noWallet);
				return wallet.connect({ client: client, chain: { id: config.chain.l2ChainId } })
					.then(function () { return wallet.getProvider ? wallet.getProvider() : window.ethereum; });
			});
		}

		return Promise.reject(new Error(i18n.noWallet));
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
		var amountInput = panel.querySelector('[data-tbay-redeem-amount]');
		var connected = null;

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

					rest('claim-tx', { claimId: voucher.claim_id, txHash: tx.hash })['catch'](function () {});
					return tx.wait().then(function () { return { txHash: tx.hash }; });
				});
		});
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
			var remainder = (Number(data.amountWei || 0) - Number(data.bridgeableWei || 0)) / 1e18;
			var rows =
				'<dl>' +
				'<dt>' + escapeHtml(i18n.bridgeAsked) + '</dt>' +
				'<dd>' + escapeHtml(amountInput ? amountInput.value : '') + ' TBAY</dd>' +
				'<dt>' + escapeHtml(i18n.bridgeReceiveL1) + '</dt>' +
				'<dd>' + escapeHtml(data.bridgeableTokens) + ' TBAY</dd>' +
				(remainder > 0
					? '<dt>' + escapeHtml(i18n.bridgeStays) + '</dt><dd>' +
					  escapeHtml(remainder.toFixed(18).replace(/0+$/, '')) + ' TBAY</dd>'
					: '') +
				'</dl>';

			output.innerHTML = rows +
				'<p class="tbay-bridge__warning">' + escapeHtml(i18n.bridgeRounding) + '</p>';
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
	 * role), so this can never burn somebody else's balance. We pass the
	 * platform-computed bridgeable amount, which is already rounded down to a
	 * whole L1 unit.
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
						return contract.crosschainBurn(signerAddress, quoteData.bridgeableWei);
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

	function boot() {
		document.querySelectorAll('[data-tbay-credit]').forEach(initCredit);
		document.querySelectorAll('[data-tbay-newsletter]').forEach(initNewsletter);
		document.querySelectorAll('[data-tbay-share]').forEach(initShare);
		document.querySelectorAll('[data-tbay-rewards]').forEach(initRewards);

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
