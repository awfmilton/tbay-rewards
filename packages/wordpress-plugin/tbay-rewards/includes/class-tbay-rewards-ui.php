<?php
/**
 * Customer-facing rewards UI: balance, rank, badges, sharing, wallet,
 * redemption and the L2 → L1 bridge.
 *
 * @package TBAY_Rewards
 */

declare( strict_types = 1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Shortcodes and REST endpoints for the member-facing rewards experience.
 *
 * Every endpoint requires a logged-in user and a REST nonce. The contact is
 * always resolved from the *session*, never from a request field, so no amount
 * of tampering with a form lets one member act on another's points or wallet.
 */
class TBAY_Rewards_UI {

	public function __construct( private TBAY_Rewards_API $api ) {
		add_shortcode( 'tbay_rewards', array( $this, 'render_dashboard' ) );
		add_shortcode( 'tbay_points', array( $this, 'render_points' ) );
		add_shortcode( 'tbay_share', array( $this, 'render_share_buttons' ) );
		add_shortcode( 'tbay_badges', array( $this, 'render_badges' ) );
		add_shortcode( 'tbay_bridge', array( $this, 'render_bridge' ) );
		add_shortcode( 'tbay_leaderboard', array( $this, 'render_leaderboard' ) );
		add_action( 'rest_api_init', array( $this, 'register_routes' ) );

		// A visit by a logged-in member counts toward their daily streak.
		add_action( 'wp', array( $this, 'maybe_record_streak' ) );
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Shortcodes
	// ─────────────────────────────────────────────────────────────────────────

	/** Just the number, for a header or menu. */
	public function render_points(): string {
		if ( ! is_user_logged_in() ) {
			return '';
		}

		$balance = $this->api->balance_for_user( get_current_user_id() );
		if ( is_wp_error( $balance ) ) {
			return '';
		}

		return sprintf(
			'<span class="tbay-root tbay-points-badge" data-tbay-points>%s</span>',
			esc_html(
				sprintf(
					/* translators: %s: formatted points balance. */
					__( '%s pts', 'tbay-rewards' ),
					number_format_i18n( (int) ( $balance['points']['balance'] ?? 0 ) )
				)
			)
		);
	}

	/** The full member dashboard. */
	public function render_dashboard(): string {
		if ( ! is_user_logged_in() ) {
			return $this->notice( __( 'Log in to see your rewards balance and redeem TBAY tokens.', 'tbay-rewards' ) );
		}

		$user_id = get_current_user_id();
		$balance = $this->api->balance_for_user( $user_id );
		if ( is_wp_error( $balance ) ) {
			return $this->notice( __( 'Your rewards account is not ready yet. Please check back shortly.', 'tbay-rewards' ) );
		}

		$gamification = $this->api->gamification_profile( $user_id );
		$chain        = $this->api->chain_config();

		$points       = (int) ( $balance['points']['balance'] ?? 0 );
		$pending      = (int) ( $balance['points']['pending'] ?? 0 );
		$earned       = (int) ( $balance['points']['lifetime_earned'] ?? 0 );
		$per_token    = (int) ( $balance['conversion']['points_per_token'] ?? 100 );
		$quote_tokens = (string) ( $balance['quote_tokens'] ?? '0' );
		$wallet       = (string) ( $balance['wallet_address'] ?? '' );
		$credit_cents = (int) ( $balance['store_credit_cents'] ?? 0 );
		$ledger       = is_array( $balance['ledger'] ?? null ) ? $balance['ledger'] : array();

		ob_start();
		?>
		<div class="tbay-root tbay-rewards" data-tbay-rewards>

			<?php // ── Balance ───────────────────────────────────────────── ?>
			<div class="tbay-rewards__grid">
				<div class="tbay-stat">
					<span class="tbay-stat__label"><?php esc_html_e( 'Available points', 'tbay-rewards' ); ?></span>
					<strong class="tbay-stat__value" data-tbay-balance><?php echo esc_html( number_format_i18n( $points ) ); ?></strong>
					<?php if ( $pending > 0 ) : ?>
						<span class="tbay-stat__sub">
							<?php
							printf(
								/* translators: %s: formatted number of pending points. */
								esc_html__( '%s pending', 'tbay-rewards' ),
								esc_html( number_format_i18n( $pending ) )
							);
							?>
						</span>
					<?php endif; ?>
				</div>

				<div class="tbay-stat">
					<span class="tbay-stat__label"><?php esc_html_e( 'Worth in TBAY', 'tbay-rewards' ); ?></span>
					<strong class="tbay-stat__value tbay-stat__value--accent" data-tbay-quote><?php echo esc_html( $quote_tokens ); ?></strong>
					<span class="tbay-stat__sub">
						<?php
						printf(
							/* translators: %s: number of points per token. */
							esc_html__( '%s points = 1 TBAY', 'tbay-rewards' ),
							esc_html( number_format_i18n( $per_token ) )
						);
						?>
					</span>
				</div>

				<div class="tbay-stat">
					<span class="tbay-stat__label"><?php esc_html_e( 'Lifetime earned', 'tbay-rewards' ); ?></span>
					<strong class="tbay-stat__value"><?php echo esc_html( number_format_i18n( $earned ) ); ?></strong>
					<?php if ( $credit_cents > 0 ) : ?>
						<span class="tbay-stat__sub">
							<?php
							printf(
								/* translators: %s: formatted store credit amount. */
								esc_html__( '%s store credit', 'tbay-rewards' ),
								esc_html( $this->format_money( $credit_cents ) )
							);
							?>
						</span>
					<?php endif; ?>
				</div>
			</div>

			<?php $this->render_rank_panel( $gamification ); ?>
			<?php $this->render_badges_panel( $gamification, 12 ); ?>
			<?php $this->render_wallet_panel( $wallet, $points, $chain ); ?>
			<?php $this->render_bridge_panel( $chain, $wallet ); ?>
			<?php $this->render_coupon_panel(); ?>
			<?php $this->render_transfer_panel( $points ); ?>
			<?php $this->render_ledger( $ledger ); ?>
		</div>
		<?php
		return (string) ob_get_clean();
	}

	/**
	 * @param array<string,mixed>|WP_Error $profile Gamification profile.
	 */
	private function render_rank_panel( $profile ): void {
		if ( is_wp_error( $profile ) || empty( $profile['rank'] ) ) {
			return;
		}

		$rank     = $profile['rank'];
		$next     = $profile['next_rank'] ?? null;
		$earned   = (int) ( $profile['balance']['lifetime_earned'] ?? 0 );
		$streaks  = is_array( $profile['streaks'] ?? null ) ? $profile['streaks'] : array();
		$daily    = 0;
		foreach ( $streaks as $streak ) {
			if ( 'daily_login' === ( $streak['key'] ?? '' ) ) {
				$daily = (int) ( $streak['current_length'] ?? 0 );
			}
		}

		// Progress is measured across the current band, not from zero, so the bar
		// reflects how far through *this* rank the member is.
		$floor   = (int) ( $rank['min_points'] ?? 0 );
		$ceiling = $next ? (int) $next['min_points'] : max( $earned, $floor + 1 );
		$span    = max( 1, $ceiling - $floor );
		$percent = $next ? max( 0, min( 100, (int) round( ( ( $earned - $floor ) / $span ) * 100 ) ) ) : 100;
		?>
		<div class="tbay-panel tbay-panel--glow">
			<span class="tbay-overline"><?php esc_html_e( 'Your standing', 'tbay-rewards' ); ?></span>

			<div class="tbay-rank">
				<div class="tbay-rank__medal" aria-hidden="true">
					<?php echo esc_html( mb_substr( (string) ( $rank['name'] ?? '?' ), 0, 1 ) ); ?>
				</div>

				<div class="tbay-rank__body">
					<p class="tbay-rank__name"><?php echo esc_html( (string) ( $rank['name'] ?? '' ) ); ?></p>
					<p class="tbay-rank__desc"><?php echo esc_html( (string) ( $rank['description'] ?? '' ) ); ?></p>

					<div class="tbay-progress" role="progressbar"
						aria-valuenow="<?php echo esc_attr( (string) $percent ); ?>"
						aria-valuemin="0" aria-valuemax="100"
						aria-label="<?php esc_attr_e( 'Progress toward the next rank', 'tbay-rewards' ); ?>">
						<div class="tbay-progress__bar" style="width:<?php echo esc_attr( (string) $percent ); ?>%"></div>
					</div>

					<span class="tbay-progress__label">
						<?php if ( $next && null !== $profile['points_to_next_rank'] ) : ?>
							<?php
							printf(
								/* translators: 1: points remaining, 2: next rank name. */
								esc_html__( '%1$s points to %2$s', 'tbay-rewards' ),
								esc_html( number_format_i18n( (int) $profile['points_to_next_rank'] ) ),
								esc_html( (string) $next['name'] )
							);
							?>
						<?php else : ?>
							<?php esc_html_e( 'Top rank reached.', 'tbay-rewards' ); ?>
						<?php endif; ?>

						<?php if ( $daily > 1 ) : ?>
							&middot;
							<?php
							printf(
								/* translators: %s: number of consecutive days. */
								esc_html__( '%s day streak', 'tbay-rewards' ),
								esc_html( number_format_i18n( $daily ) )
							);
							?>
						<?php endif; ?>
					</span>
				</div>
			</div>
		</div>
		<?php
	}

	/**
	 * @param array<string,mixed>|WP_Error $profile Gamification profile.
	 */
	private function render_badges_panel( $profile, int $limit = 0 ): void {
		if ( is_wp_error( $profile ) || empty( $profile['badges'] ) ) {
			return;
		}

		$badges = $profile['badges'];
		// Earned first — a member should see what they have before what they lack.
		usort(
			$badges,
			static fn( array $a, array $b ): int => ( (int) $b['earned_level'] ) <=> ( (int) $a['earned_level'] )
		);
		if ( $limit > 0 ) {
			$badges = array_slice( $badges, 0, $limit );
		}
		?>
		<div class="tbay-panel tbay-badges">
			<span class="tbay-overline"><?php esc_html_e( 'Badges', 'tbay-rewards' ); ?></span>

			<div class="tbay-badges__grid">
				<?php foreach ( $badges as $badge ) : ?>
					<?php
					$level   = (int) ( $badge['earned_level'] ?? 0 );
					$earned  = $level > 0;
					$tiers   = is_array( $badge['tiers'] ?? null ) ? $badge['tiers'] : array();
					$label   = '';
					foreach ( $tiers as $tier ) {
						if ( (int) ( $tier['level'] ?? 0 ) === $level ) {
							$label = (string) ( $tier['label'] ?? '' );
						}
					}
					?>
					<div class="tbay-badge <?php echo $earned ? 'tbay-badge--earned' : 'tbay-badge--locked'; ?>">
						<span class="screen-reader-text">
							<?php echo $earned
								? esc_html__( 'Earned:', 'tbay-rewards' )
								: esc_html__( 'Locked:', 'tbay-rewards' ); ?>
						</span>

						<div class="tbay-badge__icon" aria-hidden="true">
							<?php if ( ! empty( $badge['image_url'] ) ) : ?>
								<img src="<?php echo esc_url( (string) $badge['image_url'] ); ?>" alt="" loading="lazy">
							<?php else : ?>
								<?php echo $earned ? '&#9733;' : '&#9734;'; ?>
							<?php endif; ?>
						</div>

						<p class="tbay-badge__name"><?php echo esc_html( (string) ( $badge['name'] ?? '' ) ); ?></p>
						<?php if ( ! empty( $badge['description'] ) ) : ?>
							<span class="tbay-badge__desc"><?php echo esc_html( (string) $badge['description'] ); ?></span>
						<?php endif; ?>

						<?php if ( $earned && '' !== $label ) : ?>
							<span class="tbay-badge__tier"><?php echo esc_html( $label ); ?></span>
						<?php elseif ( ! $earned && ! empty( $badge['next_threshold'] ) ) : ?>
							<span class="tbay-badge__next">
								<?php
								printf(
									/* translators: %s: number required to unlock the badge. */
									esc_html__( 'Unlock at %s', 'tbay-rewards' ),
									esc_html( number_format_i18n( (int) $badge['next_threshold'] ) )
								);
								?>
							</span>
						<?php endif; ?>
					</div>
				<?php endforeach; ?>
			</div>
		</div>
		<?php
	}

	/**
	 * @param array<string,mixed>|WP_Error $chain Chain configuration.
	 */
	private function render_wallet_panel( string $wallet, int $points, $chain ): void {
		$l2      = is_wp_error( $chain ) ? array() : ( $chain['token']['l2']['chain'] ?? array() );
		$testnet = ! empty( $l2['testnet'] );
		?>
		<div class="tbay-panel tbay-wallet">
			<span class="tbay-overline"><?php esc_html_e( 'Your TBAY wallet', 'tbay-rewards' ); ?></span>

			<h3 class="tbay-title">
				<?php esc_html_e( 'Redeem points for TBAY', 'tbay-rewards' ); ?>
				<?php if ( ! empty( $l2['shortName'] ) ) : ?>
					<span class="tbay-chain-pill <?php echo $testnet ? 'tbay-chain-pill--testnet' : ''; ?>">
						<?php echo esc_html( (string) $l2['shortName'] ); ?>
					</span>
				<?php endif; ?>
			</h3>

			<p class="tbay-wallet__address" data-tbay-wallet-address>
				<?php if ( '' !== $wallet ) : ?>
					<code><?php echo esc_html( $wallet ); ?></code>
				<?php else : ?>
					<span class="tbay-muted"><?php esc_html_e( 'No wallet connected yet.', 'tbay-rewards' ); ?></span>
				<?php endif; ?>
			</p>

			<div class="tbay-wallet__actions">
				<button type="button" class="tbay-button tbay-button--outline" data-tbay-connect-wallet>
					<?php echo '' !== $wallet
						? esc_html__( 'Change wallet', 'tbay-rewards' )
						: esc_html__( 'Connect wallet', 'tbay-rewards' ); ?>
				</button>

				<label class="tbay-field tbay-field--inline">
					<span class="tbay-field__label"><?php esc_html_e( 'Points to redeem', 'tbay-rewards' ); ?></span>
					<input type="number" inputmode="numeric" min="0" step="1"
						value="<?php echo esc_attr( (string) $points ); ?>"
						max="<?php echo esc_attr( (string) $points ); ?>" data-tbay-redeem-amount>
				</label>

				<button type="button" class="tbay-button" data-tbay-redeem <?php disabled( $points <= 0 ); ?>>
					<?php esc_html_e( 'Redeem for TBAY', 'tbay-rewards' ); ?>
				</button>

				<?php
				// The short path: no wallet, no chain, no gas — just money off
				// the next order. Worth exactly what the TBAY route is worth,
				// so choosing between them is about convenience, not value.
				?>
				<button type="button" class="tbay-button tbay-button--outline" data-tbay-credit
					<?php disabled( $points <= 0 ); ?>>
					<?php esc_html_e( 'Redeem for store credit', 'tbay-rewards' ); ?>
				</button>
			</div>

			<?php // The credit code, once one has been issued. ?>
			<div data-tbay-credit-result hidden></div>

			<?php // A route into a wallet browser when this device has no provider. ?>
			<div data-tbay-wallet-help hidden></div>

			<?php // An unfinished claim from an earlier attempt, with a way to finish it. ?>
			<div data-tbay-pending hidden></div>

			<p class="tbay-wallet__status" role="status" aria-live="polite" data-tbay-wallet-status></p>

			<p class="tbay-wallet__note">
				<?php esc_html_e( 'Redeeming signs a claim voucher that only your wallet can submit, so you keep custody the whole way. TBAY spends at any retailer on the TBAY network, or bridges to Ethereum.', 'tbay-rewards' ); ?>
				<?php if ( $testnet ) : ?>
					<br><strong><?php esc_html_e( 'Test network: these tokens have no monetary value.', 'tbay-rewards' ); ?></strong>
				<?php endif; ?>
			</p>
		</div>
		<?php
	}

	/**
	 * @param array<string,mixed>|WP_Error $chain  Chain configuration.
	 */
	private function render_bridge_panel( $chain, string $wallet ): void {
		if ( is_wp_error( $chain ) ) {
			return;
		}
		?>
		<div class="tbay-panel tbay-bridge" data-tbay-bridge>
			<span class="tbay-overline"><?php esc_html_e( 'Bridge', 'tbay-rewards' ); ?></span>
			<h3 class="tbay-title"><?php esc_html_e( 'Move TBAY to Ethereum', 'tbay-rewards' ); ?></h3>

			<p class="tbay-lede">
				<?php esc_html_e( 'Burn TBAY on zkSync to release the same amount of L1 TBAY on Ethereum. Your wallet signs the burn — nothing is ever held on your behalf.', 'tbay-rewards' ); ?>
			</p>

			<div class="tbay-bridge__row">
				<label class="tbay-field tbay-field--inline">
					<span class="tbay-field__label"><?php esc_html_e( 'TBAY to move', 'tbay-rewards' ); ?></span>
					<input type="number" inputmode="decimal" min="0" step="0.000000001"
						placeholder="0.0" data-tbay-bridge-amount>
				</label>

				<button type="button" class="tbay-button tbay-button--outline" data-tbay-bridge-quote>
					<?php esc_html_e( 'Preview', 'tbay-rewards' ); ?>
				</button>

				<button type="button" class="tbay-button" data-tbay-bridge-submit>
					<?php esc_html_e( 'Bridge to L1', 'tbay-rewards' ); ?>
				</button>
			</div>

			<div class="tbay-bridge__quote" data-tbay-bridge-quote-output hidden></div>

			<?php // A burn we have not managed to record yet, with a retry. ?>
			<div data-tbay-bridge-pending hidden></div>

			<p class="tbay-bridge__status" role="status" aria-live="polite" data-tbay-bridge-status></p>

			<p class="tbay-wallet__note">
				<?php esc_html_e( 'L1 TBAY uses 9 decimals against 18 on L2, so any remainder smaller than one L1 unit cannot cross and is swept to the treasury by the contract. The preview shows exactly what will cross before you sign.', 'tbay-rewards' ); ?>
			</p>

			<?php if ( '' === $wallet ) : ?>
				<p class="tbay-bridge__warning">
					<?php esc_html_e( 'Connect a wallet above before bridging.', 'tbay-rewards' ); ?>
				</p>
			<?php endif; ?>
		</div>
		<?php
	}

	private function render_coupon_panel(): void {
		?>
		<div class="tbay-panel" data-tbay-coupon>
			<span class="tbay-overline"><?php esc_html_e( 'Have a code?', 'tbay-rewards' ); ?></span>
			<h3 class="tbay-title"><?php esc_html_e( 'Redeem a reward code', 'tbay-rewards' ); ?></h3>

			<div class="tbay-wallet__actions">
				<label class="tbay-field tbay-field--grow">
					<span class="screen-reader-text"><?php esc_html_e( 'Reward code', 'tbay-rewards' ); ?></span>
					<input type="text" autocomplete="off" spellcheck="false"
						placeholder="<?php esc_attr_e( 'WELCOME50', 'tbay-rewards' ); ?>"
						data-tbay-coupon-code>
				</label>

				<button type="button" class="tbay-button tbay-button--outline" data-tbay-coupon-submit>
					<?php esc_html_e( 'Redeem code', 'tbay-rewards' ); ?>
				</button>
			</div>

			<p class="tbay-wallet__status" role="status" aria-live="polite" data-tbay-coupon-status></p>
		</div>
		<?php
	}

	private function render_transfer_panel( int $points ): void {
		?>
		<div class="tbay-panel" data-tbay-transfer>
			<span class="tbay-overline"><?php esc_html_e( 'Send points', 'tbay-rewards' ); ?></span>
			<h3 class="tbay-title"><?php esc_html_e( 'Gift points to someone', 'tbay-rewards' ); ?></h3>

			<p class="tbay-lede">
				<?php esc_html_e( 'Send points to another member by email. They receive them instantly.', 'tbay-rewards' ); ?>
			</p>

			<div class="tbay-wallet__actions">
				<label class="tbay-field tbay-field--grow">
					<span class="screen-reader-text"><?php esc_html_e( 'Recipient email', 'tbay-rewards' ); ?></span>
					<input type="email" autocomplete="off"
						placeholder="<?php esc_attr_e( 'them@example.com', 'tbay-rewards' ); ?>"
						data-tbay-transfer-email>
				</label>

				<label class="tbay-field tbay-field--inline">
					<span class="tbay-field__label"><?php esc_html_e( 'Points to send', 'tbay-rewards' ); ?></span>
					<input type="number" inputmode="numeric" min="1" step="1"
						max="<?php echo esc_attr( (string) $points ); ?>"
						placeholder="100" data-tbay-transfer-amount>
				</label>

				<button type="button" class="tbay-button tbay-button--outline"
					data-tbay-transfer-submit <?php disabled( $points <= 0 ); ?>>
					<?php esc_html_e( 'Send points', 'tbay-rewards' ); ?>
				</button>
			</div>

			<p class="tbay-wallet__status" role="status" aria-live="polite" data-tbay-transfer-status></p>
		</div>
		<?php
	}

	/**
	 * @param array<int,array<string,mixed>> $ledger Ledger entries.
	 */
	private function render_ledger( array $ledger ): void {
		if ( empty( $ledger ) ) {
			return;
		}
		?>
		<div class="tbay-panel">
			<span class="tbay-overline"><?php esc_html_e( 'Recent activity', 'tbay-rewards' ); ?></span>

			<div class="tbay-table-wrap">
				<table class="tbay-ledger">
					<thead>
						<tr>
							<th scope="col"><?php esc_html_e( 'Date', 'tbay-rewards' ); ?></th>
							<th scope="col"><?php esc_html_e( 'Activity', 'tbay-rewards' ); ?></th>
							<th scope="col" class="tbay-num"><?php esc_html_e( 'Points', 'tbay-rewards' ); ?></th>
						</tr>
					</thead>
					<tbody>
					<?php foreach ( $ledger as $entry ) : ?>
						<?php
						$delta   = (int) ( $entry['delta_points'] ?? 0 );
						$created = isset( $entry['created_at'] ) ? strtotime( (string) $entry['created_at'] ) : false;
						?>
						<tr>
							<td><?php echo esc_html( $created ? date_i18n( (string) get_option( 'date_format' ), $created ) : '—' ); ?></td>
							<td>
								<?php echo esc_html( (string) ( $entry['reason'] ?? '' ) ); ?>
								<?php if ( 'pending' === ( $entry['status'] ?? '' ) ) : ?>
									<em>(<?php esc_html_e( 'pending', 'tbay-rewards' ); ?>)</em>
								<?php endif; ?>
							</td>
							<td class="tbay-num <?php echo $delta >= 0 ? 'tbay-pos' : 'tbay-neg'; ?>">
								<?php echo esc_html( ( $delta >= 0 ? '+' : '' ) . number_format_i18n( $delta ) ); ?>
							</td>
						</tr>
					<?php endforeach; ?>
					</tbody>
				</table>
			</div>
		</div>
		<?php
	}

	/** Standalone badge wall. */
	public function render_badges(): string {
		if ( ! is_user_logged_in() ) {
			return $this->notice( __( 'Log in to see the badges you have earned.', 'tbay-rewards' ) );
		}

		$profile = $this->api->gamification_profile( get_current_user_id() );
		if ( is_wp_error( $profile ) ) {
			return '';
		}

		ob_start();
		echo '<div class="tbay-root">';
		$this->render_badges_panel( $profile );
		echo '</div>';
		return (string) ob_get_clean();
	}

	/** Standalone bridge panel. */
	public function render_bridge(): string {
		if ( ! is_user_logged_in() ) {
			return $this->notice( __( 'Log in to bridge your TBAY to Ethereum.', 'tbay-rewards' ) );
		}

		$balance = $this->api->balance_for_user( get_current_user_id() );
		$wallet  = is_wp_error( $balance ) ? '' : (string) ( $balance['wallet_address'] ?? '' );

		ob_start();
		// No data-tbay-rewards wrapper: that attribute makes the script treat
		// this as a full dashboard and look for wallet controls that a
		// standalone bridge panel does not render, leaving every click stuck on
		// "connect your wallet".
		echo '<div class="tbay-root tbay-rewards">';

		if ( '' !== $wallet ) {
			printf(
				'<p class="tbay-wallet__address" data-tbay-wallet-address><code>%s</code></p>',
				esc_html( $wallet )
			);
		} else {
			printf(
				'<p class="tbay-notice">%s</p>',
				esc_html__( 'Connect and verify a wallet on your rewards page before bridging.', 'tbay-rewards' )
			);
		}

		$this->render_bridge_panel( $this->api->chain_config(), $wallet );
		echo '</div>';
		return (string) ob_get_clean();
	}

	/**
	 * @param array<string,string>|string $atts Shortcode attributes.
	 */
	public function render_leaderboard( $atts = array() ): string {
		$atts = shortcode_atts(
			array( 'limit' => '10' ),
			is_array( $atts ) ? $atts : array(),
			'tbay_leaderboard'
		);

		$result = $this->api->get_cached( '/v1/rewards/leaderboard', array(), 300 );
		if ( is_wp_error( $result ) || empty( $result['leaders'] ) ) {
			return '';
		}

		$leaders = array_slice( (array) $result['leaders'], 0, max( 1, (int) $atts['limit'] ) );

		ob_start();
		?>
		<div class="tbay-root">
			<div class="tbay-panel">
				<span class="tbay-overline"><?php esc_html_e( 'Top members', 'tbay-rewards' ); ?></span>
				<div class="tbay-table-wrap">
					<table class="tbay-ledger">
						<thead>
							<tr>
								<th scope="col"><?php esc_html_e( 'Member', 'tbay-rewards' ); ?></th>
								<th scope="col" class="tbay-num"><?php esc_html_e( 'Lifetime points', 'tbay-rewards' ); ?></th>
							</tr>
						</thead>
						<tbody>
						<?php foreach ( $leaders as $index => $leader ) : ?>
							<tr>
								<td>
									<?php echo esc_html( (string) ( $index + 1 ) ); ?>.
									<?php
									// Only a display name is ever shown — never an email address.
									$name = (string) ( $leader['name'] ?? '' );
									echo esc_html( '' !== $name ? $name : __( 'Anonymous', 'tbay-rewards' ) );
									?>
								</td>
								<td class="tbay-num"><?php echo esc_html( number_format_i18n( (int) ( $leader['lifetime_earned'] ?? 0 ) ) ); ?></td>
							</tr>
						<?php endforeach; ?>
						</tbody>
					</table>
				</div>
			</div>
		</div>
		<?php
		return (string) ob_get_clean();
	}

	/**
	 * Share buttons that mint a tracked link and pay points once clicked.
	 *
	 * @param array<string,string>|string $atts Shortcode attributes.
	 */
	public function render_share_buttons( $atts = array() ): string {
		$atts = shortcode_atts(
			array(
				'networks' => 'x,facebook,linkedin,pinterest,copy',
				'url'      => '',
				'title'    => __( 'Share and earn points', 'tbay-rewards' ),
			),
			is_array( $atts ) ? $atts : array(),
			'tbay_share'
		);

		if ( ! is_user_logged_in() ) {
			return $this->notice( __( 'Log in to earn reward points when you share.', 'tbay-rewards' ) );
		}

		$target = '' !== $atts['url'] ? esc_url_raw( $atts['url'] ) : (string) get_permalink();
		if ( '' === $target ) {
			return '';
		}

		$networks = array_filter( array_map( 'sanitize_key', explode( ',', $atts['networks'] ) ) );
		$labels   = array(
			'x'         => __( 'X', 'tbay-rewards' ),
			'facebook'  => __( 'Facebook', 'tbay-rewards' ),
			'linkedin'  => __( 'LinkedIn', 'tbay-rewards' ),
			'pinterest' => __( 'Pinterest', 'tbay-rewards' ),
			'reddit'    => __( 'Reddit', 'tbay-rewards' ),
			'whatsapp'  => __( 'WhatsApp', 'tbay-rewards' ),
			'telegram'  => __( 'Telegram', 'tbay-rewards' ),
			'email'     => __( 'Email', 'tbay-rewards' ),
			'copy'      => __( 'Copy link', 'tbay-rewards' ),
		);

		$product_ref = ( function_exists( 'is_product' ) && is_product() ) ? (string) get_the_ID() : '';
		$post_ref    = is_singular() ? (string) get_the_ID() : '';

		ob_start();
		?>
		<div class="tbay-root tbay-share" data-tbay-share
			data-url="<?php echo esc_url( $target ); ?>"
			data-product="<?php echo esc_attr( $product_ref ); ?>"
			data-post="<?php echo esc_attr( $post_ref ); ?>">

			<?php if ( '' !== $atts['title'] ) : ?>
				<span class="tbay-share__title"><?php echo esc_html( $atts['title'] ); ?></span>
			<?php endif; ?>

			<div class="tbay-share__buttons">
				<?php foreach ( $networks as $network ) : ?>
					<?php if ( ! isset( $labels[ $network ] ) ) { continue; } ?>
					<button type="button" class="tbay-share__button" data-network="<?php echo esc_attr( $network ); ?>">
						<?php echo esc_html( $labels[ $network ] ); ?>
					</button>
				<?php endforeach; ?>
			</div>

			<p class="tbay-share__status" role="status" aria-live="polite"></p>
		</div>
		<?php
		return (string) ob_get_clean();
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Streaks
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Count one visit per member per day toward their streak.
	 *
	 * Guarded by a same-day user meta check so a member browsing twenty pages
	 * costs one API call, not twenty. The platform enforces once-per-day too.
	 */
	public function maybe_record_streak(): void {
		if ( is_admin() || ! is_user_logged_in() || ! $this->api->is_configured() ) {
			return;
		}
		if ( wp_doing_ajax() || wp_doing_cron() || ( function_exists( 'wp_is_json_request' ) && wp_is_json_request() ) ) {
			return;
		}

		$user_id = get_current_user_id();
		$today   = current_time( 'Y-m-d' );
		if ( get_user_meta( $user_id, '_tbay_streak_day', true ) === $today ) {
			return;
		}
		update_user_meta( $user_id, '_tbay_streak_day', $today );

		$contact_id = $this->api->contact_id_for_user( $user_id );
		if ( null === $contact_id ) {
			return;
		}

		$this->api->post( '/v1/gamification/streak', array( 'contactId' => $contact_id, 'key' => 'daily_login' ) );
	}

	// ─────────────────────────────────────────────────────────────────────────
	// REST endpoints
	// ─────────────────────────────────────────────────────────────────────────

	public function register_routes(): void {
		$logged_in = static fn(): bool => is_user_logged_in();

		$routes = array(
			'share'            => array( 'POST', 'handle_share' ),
			'wallet/challenge' => array( 'POST', 'handle_wallet_challenge' ),
			'wallet'           => array( 'POST', 'handle_wallet' ),
			'redeem'         => array( 'POST', 'handle_redeem' ),
			'credit'         => array( 'POST', 'handle_credit' ),
			'credit-quote'   => array( 'GET', 'handle_credit_quote' ),
			'claim-tx'       => array( 'POST', 'handle_claim_tx' ),
			'balance'        => array( 'GET', 'handle_balance' ),
			'profile'        => array( 'GET', 'handle_profile' ),
			'bridge/quote'   => array( 'POST', 'handle_bridge_quote' ),
			'bridge/submit'  => array( 'POST', 'handle_bridge_submit' ),
			'bridge/history' => array( 'GET', 'handle_bridge_history' ),
			'coupon'         => array( 'POST', 'handle_coupon' ),
			'transfer'       => array( 'POST', 'handle_transfer' ),
			'notifications'  => array( 'GET', 'handle_notifications' ),
			'notifications/read' => array( 'POST', 'handle_notifications_read' ),
		);

		foreach ( $routes as $path => $spec ) {
			register_rest_route(
				'tbay/v1',
				'/' . $path,
				array(
					'methods'             => 'GET' === $spec[0] ? WP_REST_Server::READABLE : WP_REST_Server::CREATABLE,
					'callback'            => array( $this, $spec[1] ),
					'permission_callback' => $logged_in,
				)
			);
		}
	}

	/**
	 * Badge, rank and streak notifications for the signed-in member.
	 *
	 * The platform has written these since gamification shipped and nothing
	 * ever read them, so an unlocked badge was a row in a table the customer
	 * never saw. Unread-only by default: the toast strip shows what is new,
	 * and the rewards page can ask for the full list.
	 */
	public function handle_notifications( WP_REST_Request $request ): WP_REST_Response {
		$contact_id = $this->require_contact();
		if ( null === $contact_id ) {
			return $this->error( __( 'Your rewards account is not ready yet.', 'tbay-rewards' ) );
		}

		$result = $this->api->request(
			'GET',
			'/v1/gamification/notifications',
			array(),
			array(
				'contactId' => $contact_id,
				// The platform reads `unread=1`; anything else means all.
				'unread'    => $request->get_param( 'all' ) ? '0' : '1',
			)
		);

		return is_wp_error( $result )
			? $this->error( $result->get_error_message() )
			: new WP_REST_Response( $result, 200 );
	}

	/** Mark notifications seen so they do not pop again on the next page. */
	public function handle_notifications_read( WP_REST_Request $request ): WP_REST_Response {
		$contact_id = $this->require_contact();
		if ( null === $contact_id ) {
			return $this->error( __( 'Your rewards account is not ready yet.', 'tbay-rewards' ) );
		}

		$ids = $request->get_param( 'ids' );
		$ids = is_array( $ids ) ? array_slice( array_map( 'sanitize_text_field', $ids ), 0, 50 ) : array();

		$result = $this->api->post(
			'/v1/gamification/notifications/read',
			array( 'contactId' => $contact_id, 'ids' => $ids )
		);

		return is_wp_error( $result )
			? $this->error( $result->get_error_message() )
			: new WP_REST_Response( $result, 200 );
	}

	public function handle_share( WP_REST_Request $request ): WP_REST_Response {
		$contact_id = $this->require_contact();
		if ( null === $contact_id ) {
			return $this->error( __( 'Your rewards account is not ready yet.', 'tbay-rewards' ) );
		}

		$url = esc_url_raw( (string) $request->get_param( 'url' ) );
		if ( '' === $url ) {
			return $this->error( __( 'Nothing to share.', 'tbay-rewards' ) );
		}

		$result = $this->api->post(
			'/v1/shares',
			array(
				'contactId'  => $contact_id,
				'network'    => sanitize_key( (string) $request->get_param( 'network' ) ),
				'targetUrl'  => $url,
				'productRef' => sanitize_text_field( (string) $request->get_param( 'product' ) ) ?: null,
				'postRef'    => sanitize_text_field( (string) $request->get_param( 'post' ) ) ?: null,
			)
		);

		return is_wp_error( $result )
			? $this->error( $result->get_error_message() )
			: new WP_REST_Response( $result, 200 );
	}

	/**
	 * Step one of linking a wallet: ask the platform for a challenge to sign.
	 *
	 * Wallets are never bound on a claim alone — anything that later trusts the
	 * stored address (bridging above all) would otherwise be pointable at an
	 * address the member does not control.
	 */
	public function handle_wallet_challenge( WP_REST_Request $request ): WP_REST_Response {
		$contact_id = $this->require_contact();
		if ( null === $contact_id ) {
			return $this->error( __( 'Your rewards account is not ready yet.', 'tbay-rewards' ) );
		}

		$address = $this->sanitize_address( (string) $request->get_param( 'walletAddress' ) );
		if ( null === $address ) {
			return $this->error( __( 'That does not look like a wallet address.', 'tbay-rewards' ) );
		}

		$result = $this->api->post(
			'/v1/wallet/challenge',
			array( 'contactId' => $contact_id, 'walletAddress' => $address )
		);

		return is_wp_error( $result )
			? $this->error( $result->get_error_message() )
			: new WP_REST_Response( $result, 200 );
	}

	/** Step two: hand the signature back so the platform can verify it. */
	public function handle_wallet( WP_REST_Request $request ): WP_REST_Response {
		$contact_id = $this->require_contact();
		if ( null === $contact_id ) {
			return $this->error( __( 'Your rewards account is not ready yet.', 'tbay-rewards' ) );
		}

		$nonce     = sanitize_text_field( (string) $request->get_param( 'nonce' ) );
		$signature = sanitize_text_field( (string) $request->get_param( 'signature' ) );
		$message   = sanitize_textarea_field( (string) $request->get_param( 'message' ) );

		if ( '' === $nonce || ! preg_match( '/^0x[0-9a-fA-F]{100,}$/', $signature ) || '' === $message ) {
			return $this->error( __( 'That wallet signature could not be read.', 'tbay-rewards' ) );
		}

		$result = $this->api->post(
			'/v1/contacts/wallet',
			array(
				'contactId' => $contact_id,
				'nonce'     => $nonce,
				'signature' => $signature,
				'message'   => $message,
			)
		);
		if ( is_wp_error( $result ) ) {
			return $this->error( $result->get_error_message(), 403 );
		}

		// Only recorded locally once the platform has actually verified it.
		if ( ! empty( $result['wallet_address'] ) ) {
			update_user_meta(
				get_current_user_id(),
				'_tbay_wallet',
				sanitize_text_field( (string) $result['wallet_address'] )
			);
		}
		$this->api->flush_cache();

		return new WP_REST_Response( $result, 200 );
	}

	/**
	 * Sign a claim voucher for the current user.
	 *
	 * The amount comes from the request; the identity never does. The contact is
	 * resolved from the session, so editing a form field cannot redeem someone
	 * else's points — and the voucher is bound by signature to the wallet the
	 * *platform* has on file for that contact.
	 */
	/**
	 * Spend points for a store credit code.
	 *
	 * The short path to money off an order: no wallet, no chain, no gas. Worth
	 * exactly what the TBAY route is worth, so a customer choosing between them
	 * is choosing convenience rather than value.
	 */
	public function handle_credit( WP_REST_Request $request ): WP_REST_Response {
		$contact_id = $this->require_contact();
		if ( null === $contact_id ) {
			return $this->error( __( 'Your rewards account is not ready yet.', 'tbay-rewards' ) );
		}

		$points = (int) $request->get_param( 'points' );
		if ( $points <= 0 ) {
			return $this->error( __( 'How many points would you like to use?', 'tbay-rewards' ) );
		}

		$result = $this->api->post(
			'/v1/credit/redeem',
			array( 'contactId' => $contact_id, 'points' => $points )
		);

		return is_wp_error( $result )
			? $this->error( $result->get_error_message() )
			: new WP_REST_Response( $result, 200 );
	}

	/** What a number of points is worth, before anything is spent. */
	public function handle_credit_quote( WP_REST_Request $request ): WP_REST_Response {
		$result = $this->api->request(
			'GET',
			'/v1/credit/quote',
			array(),
			array( 'points' => (int) $request->get_param( 'points' ) )
		);

		return is_wp_error( $result )
			? $this->error( $result->get_error_message() )
			: new WP_REST_Response( $result, 200 );
	}

	public function handle_redeem( WP_REST_Request $request ): WP_REST_Response {
		$contact_id = $this->require_contact();
		if ( null === $contact_id ) {
			return $this->error( __( 'Your rewards account is not ready yet.', 'tbay-rewards' ) );
		}

		$points = (int) $request->get_param( 'points' );
		if ( $points <= 0 ) {
			return $this->error( __( 'Enter how many points to redeem.', 'tbay-rewards' ) );
		}

		$address = $this->sanitize_address( (string) $request->get_param( 'walletAddress' ) );
		if ( null === $address ) {
			return $this->error( __( 'Connect a wallet before redeeming.', 'tbay-rewards' ) );
		}

		$result = $this->api->post(
			'/v1/token/redeem',
			array( 'contactId' => $contact_id, 'points' => $points, 'walletAddress' => $address )
		);
		if ( is_wp_error( $result ) ) {
			return $this->error( $result->get_error_message() );
		}

		$this->api->flush_cache();
		return new WP_REST_Response( $result, 200 );
	}

	public function handle_claim_tx( WP_REST_Request $request ): WP_REST_Response {
		$claim_id = sanitize_text_field( (string) $request->get_param( 'claimId' ) );
		$tx_hash  = sanitize_text_field( (string) $request->get_param( 'txHash' ) );

		if ( '' === $claim_id || ! preg_match( '/^0x[0-9a-fA-F]{64}$/', $tx_hash ) ) {
			return $this->error( __( 'Invalid transaction reference.', 'tbay-rewards' ) );
		}

		$result = $this->api->post(
			'/v1/token/claims/' . rawurlencode( $claim_id ) . '/tx',
			array( 'txHash' => $tx_hash )
		);

		return is_wp_error( $result )
			? $this->error( $result->get_error_message() )
			: new WP_REST_Response( $result, 200 );
	}

	public function handle_balance(): WP_REST_Response {
		$balance = $this->api->balance_for_user( get_current_user_id(), 0 );
		return is_wp_error( $balance )
			? $this->error( $balance->get_error_message() )
			: new WP_REST_Response( $balance, 200 );
	}

	public function handle_profile(): WP_REST_Response {
		$profile = $this->api->gamification_profile( get_current_user_id(), 0 );
		return is_wp_error( $profile )
			? $this->error( $profile->get_error_message() )
			: new WP_REST_Response( $profile, 200 );
	}

	public function handle_bridge_quote( WP_REST_Request $request ): WP_REST_Response {
		$amount = (float) $request->get_param( 'amountTokens' );
		if ( $amount <= 0 ) {
			return $this->error( __( 'Enter how much TBAY to bridge.', 'tbay-rewards' ) );
		}

		$result = $this->api->post( '/v1/bridge/quote', array( 'amountTokens' => $amount ) );
		return is_wp_error( $result )
			? $this->error( $result->get_error_message() )
			: new WP_REST_Response( $result, 200 );
	}

	/**
	 * Submit a completed L2 burn.
	 *
	 * The wallet address is taken from the platform's record for this contact,
	 * not from the request, so a member can only ever submit a burn made by
	 * their own registered wallet. The platform then re-verifies the burn
	 * on-chain before recording anything.
	 */
	public function handle_bridge_submit( WP_REST_Request $request ): WP_REST_Response {
		$contact_id = $this->require_contact();
		if ( null === $contact_id ) {
			return $this->error( __( 'Your rewards account is not ready yet.', 'tbay-rewards' ) );
		}

		$tx_hash = sanitize_text_field( (string) $request->get_param( 'txHash' ) );
		if ( ! preg_match( '/^0x[0-9a-fA-F]{64}$/', $tx_hash ) ) {
			return $this->error( __( 'Invalid transaction reference.', 'tbay-rewards' ) );
		}

		$wallet = get_user_meta( get_current_user_id(), '_tbay_wallet', true );
		if ( ! is_string( $wallet ) || null === $this->sanitize_address( $wallet ) ) {
			return $this->error( __( 'Connect a wallet before bridging.', 'tbay-rewards' ) );
		}

		$recipient = $this->sanitize_address( (string) $request->get_param( 'l1Recipient' ) );

		$result = $this->api->post(
			'/v1/bridge/withdrawals',
			array(
				'contactId'   => $contact_id,
				'burnTxHash'  => $tx_hash,
				'fromAddress' => $wallet,
				'l1Recipient' => $recipient,
			)
		);

		return is_wp_error( $result )
			? $this->error( $result->get_error_message() )
			: new WP_REST_Response( $result, 200 );
	}

	public function handle_bridge_history(): WP_REST_Response {
		$wallet = get_user_meta( get_current_user_id(), '_tbay_wallet', true );
		if ( ! is_string( $wallet ) || '' === $wallet ) {
			return new WP_REST_Response( array( 'withdrawals' => array() ), 200 );
		}

		$result = $this->api->get( '/v1/bridge/withdrawals', array( 'fromAddress' => $wallet ) );
		return is_wp_error( $result )
			? $this->error( $result->get_error_message() )
			: new WP_REST_Response( $result, 200 );
	}

	public function handle_coupon( WP_REST_Request $request ): WP_REST_Response {
		$contact_id = $this->require_contact();
		if ( null === $contact_id ) {
			return $this->error( __( 'Your rewards account is not ready yet.', 'tbay-rewards' ) );
		}

		$code = sanitize_text_field( (string) $request->get_param( 'code' ) );
		if ( '' === $code ) {
			return $this->error( __( 'Enter a code.', 'tbay-rewards' ) );
		}

		$result = $this->api->post(
			'/v1/gamification/coupons/redeem',
			array( 'contactId' => $contact_id, 'code' => $code )
		);
		if ( is_wp_error( $result ) ) {
			return $this->error( $result->get_error_message(), 422 );
		}

		$this->api->flush_cache();
		return new WP_REST_Response( $result, 200 );
	}

	public function handle_transfer( WP_REST_Request $request ): WP_REST_Response {
		$contact_id = $this->require_contact();
		if ( null === $contact_id ) {
			return $this->error( __( 'Your rewards account is not ready yet.', 'tbay-rewards' ) );
		}

		$to_email = sanitize_email( (string) $request->get_param( 'toEmail' ) );
		$points   = (int) $request->get_param( 'points' );

		if ( ! is_email( $to_email ) || $points <= 0 ) {
			return $this->error( __( 'Enter a valid recipient and amount.', 'tbay-rewards' ) );
		}

		$result = $this->api->post(
			'/v1/gamification/transfer',
			array(
				// The sender is always the session's own contact.
				'fromContactId' => $contact_id,
				'toEmail'       => $to_email,
				'points'        => $points,
				'message'       => sanitize_text_field( (string) $request->get_param( 'message' ) ),
			)
		);
		if ( is_wp_error( $result ) ) {
			return $this->error( $result->get_error_message(), 422 );
		}

		$this->api->flush_cache();
		return new WP_REST_Response( $result, 200 );
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Helpers
	// ─────────────────────────────────────────────────────────────────────────

	private function require_contact(): ?string {
		return $this->api->contact_id_for_user( get_current_user_id() );
	}

	private function sanitize_address( string $address ): ?string {
		$address = trim( $address );
		return preg_match( '/^0x[0-9a-fA-F]{40}$/', $address ) ? $address : null;
	}

	private function error( string $message, int $status = 400 ): WP_REST_Response {
		return new WP_REST_Response( array( 'message' => $message ), $status );
	}

	private function notice( string $message ): string {
		return sprintf( '<div class="tbay-root"><p class="tbay-notice">%s</p></div>', esc_html( $message ) );
	}

	private function format_money( int $cents ): string {
		if ( function_exists( 'wc_price' ) ) {
			return wp_strip_all_tags( (string) wc_price( $cents / 100 ) );
		}
		return number_format_i18n( $cents / 100, 2 );
	}
}
