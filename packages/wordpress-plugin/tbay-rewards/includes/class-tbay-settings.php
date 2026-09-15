<?php
/**
 * Settings screen.
 *
 * @package TBAY_Rewards
 */

declare( strict_types = 1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Settings → TBAY Rewards.
 */
class TBAY_Rewards_Settings {

	private const OPTION = 'tbay_rewards_settings';
	private const GROUP  = 'tbay_rewards';

	public function __construct( private TBAY_Rewards_API $api ) {
		add_action( 'admin_init', array( $this, 'register' ) );
		add_action( 'admin_menu', array( $this, 'add_page' ) );
		add_filter( 'plugin_action_links_' . plugin_basename( TBAY_REWARDS_FILE ), array( $this, 'action_links' ) );
	}

	/**
	 * @param string[] $links Existing action links.
	 * @return string[]
	 */
	public function action_links( array $links ): array {
		array_unshift(
			$links,
			sprintf(
				'<a href="%s">%s</a>',
				esc_url( admin_url( 'options-general.php?page=tbay-rewards' ) ),
				esc_html__( 'Settings', 'tbay-rewards' )
			)
		);
		return $links;
	}

	public function add_page(): void {
		add_options_page(
			__( 'TBAY Rewards', 'tbay-rewards' ),
			__( 'TBAY Rewards', 'tbay-rewards' ),
			'manage_options',
			'tbay-rewards',
			array( $this, 'render' )
		);
	}

	public function register(): void {
		register_setting(
			self::GROUP,
			self::OPTION,
			array(
				'type'              => 'array',
				'sanitize_callback' => array( $this, 'sanitize' ),
				'default'           => array(),
			)
		);
	}

	/**
	 * @param mixed $input Raw submitted settings.
	 * @return array<string,mixed>
	 */
	public function sanitize( $input ): array {
		$input    = is_array( $input ) ? $input : array();
		$existing = $this->api->settings();

		$clean = array(
			'endpoint'          => esc_url_raw( untrailingslashit( (string) ( $input['endpoint'] ?? '' ) ) ),
			'public_key'        => sanitize_text_field( (string) ( $input['public_key'] ?? '' ) ),
			'enable_tracking'   => empty( $input['enable_tracking'] ) ? 0 : 1,
			'enable_heatmaps'   => empty( $input['enable_heatmaps'] ) ? 0 : 1,
			'require_consent'   => empty( $input['require_consent'] ) ? 0 : 1,
			'enable_commerce'   => empty( $input['enable_commerce'] ) ? 0 : 1,
			'enable_rewards'    => empty( $input['enable_rewards'] ) ? 0 : 1,
			'writer_rate_bps'   => min( 10000, max( 0, absint( $input['writer_rate_bps'] ?? 500 ) ) ),
			'mycred_point_type' => sanitize_key( (string) ( $input['mycred_point_type'] ?? 'mycred_default' ) ),
			'mycred_sync'       => empty( $input['mycred_sync'] ) ? 0 : 1,
		);

		// A blank secret field means "leave it alone", so re-saving the page
		// never wipes a credential the admin cannot see.
		$submitted_secret        = trim( (string) ( $input['secret_key'] ?? '' ) );
		$clean['secret_key']     = '' !== $submitted_secret
			? sanitize_text_field( $submitted_secret )
			: (string) ( $existing['secret_key'] ?? '' );

		$clean['webhook_secret'] = (string) ( $existing['webhook_secret'] ?? '' );
		if ( '' === $clean['webhook_secret'] || ! empty( $input['regenerate_webhook_secret'] ) ) {
			$clean['webhook_secret'] = wp_generate_password( 40, false );
		}

		$this->api->flush_cache();
		return $clean;
	}

	public function render(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to change these settings.', 'tbay-rewards' ) );
		}

		$settings   = $this->api->settings();
		$configured = $this->api->is_configured();
		$health     = $configured ? $this->api->get( '/health' ) : null;
		?>
		<div class="wrap">
			<h1><?php esc_html_e( 'TBAY Rewards', 'tbay-rewards' ); ?></h1>

			<?php if ( $configured ) : ?>
				<?php if ( is_wp_error( $health ) ) : ?>
					<div class="notice notice-error">
						<p>
							<?php
							printf(
								/* translators: %s: error message. */
								esc_html__( 'Could not reach the rewards platform: %s', 'tbay-rewards' ),
								esc_html( $health->get_error_message() )
							);
							?>
						</p>
					</div>
				<?php else : ?>
					<div class="notice notice-success">
						<p>
							<?php esc_html_e( 'Connected to the rewards platform.', 'tbay-rewards' ); ?>
							<?php if ( empty( $health['signer_configured'] ) ) : ?>
								<br>
								<strong><?php esc_html_e( 'Token redemption is disabled:', 'tbay-rewards' ); ?></strong>
								<?php esc_html_e( 'the platform has no claim signer key configured.', 'tbay-rewards' ); ?>
							<?php endif; ?>
						</p>
					</div>
				<?php endif; ?>
			<?php else : ?>
				<div class="notice notice-warning">
					<p><?php esc_html_e( 'Add your endpoint and API keys below to start collecting data.', 'tbay-rewards' ); ?></p>
				</div>
			<?php endif; ?>

			<form method="post" action="options.php">
				<?php settings_fields( self::GROUP ); ?>

				<h2 class="title"><?php esc_html_e( 'Connection', 'tbay-rewards' ); ?></h2>
				<table class="form-table" role="presentation">
					<tr>
						<th scope="row">
							<label for="tbay-endpoint"><?php esc_html_e( 'Platform URL', 'tbay-rewards' ); ?></label>
						</th>
						<td>
							<input type="url" id="tbay-endpoint" class="regular-text code"
								name="<?php echo esc_attr( self::OPTION ); ?>[endpoint]"
								value="<?php echo esc_attr( (string) ( $settings['endpoint'] ?? '' ) ); ?>"
								placeholder="https://rewards.example.com">
							<p class="description"><?php esc_html_e( 'Where your TBAY Rewards server is running.', 'tbay-rewards' ); ?></p>
						</td>
					</tr>
					<tr>
						<th scope="row">
							<label for="tbay-public-key"><?php esc_html_e( 'Site key', 'tbay-rewards' ); ?></label>
						</th>
						<td>
							<input type="text" id="tbay-public-key" class="regular-text code"
								name="<?php echo esc_attr( self::OPTION ); ?>[public_key]"
								value="<?php echo esc_attr( (string) ( $settings['public_key'] ?? '' ) ); ?>"
								placeholder="tbp_…">
							<p class="description"><?php esc_html_e( 'Safe to expose — it appears in your page source and can only write analytics.', 'tbay-rewards' ); ?></p>
						</td>
					</tr>
					<tr>
						<th scope="row">
							<label for="tbay-secret-key"><?php esc_html_e( 'API secret', 'tbay-rewards' ); ?></label>
						</th>
						<td>
							<input type="password" id="tbay-secret-key" class="regular-text code"
								name="<?php echo esc_attr( self::OPTION ); ?>[secret_key]"
								value="" autocomplete="off"
								placeholder="<?php echo empty( $settings['secret_key'] )
									? esc_attr__( 'tbs_….…', 'tbay-rewards' )
									: esc_attr__( '•••••••• (leave blank to keep)', 'tbay-rewards' ); ?>">
							<p class="description"><?php esc_html_e( 'Server-to-server only. Never shown again after saving.', 'tbay-rewards' ); ?></p>
						</td>
					</tr>
					<tr>
						<th scope="row"><?php esc_html_e( 'Webhook URL', 'tbay-rewards' ); ?></th>
						<td>
							<code><?php echo esc_html( rest_url( 'tbay/v1/webhook' ) ); ?></code>
							<p class="description">
								<?php esc_html_e( 'Signing secret:', 'tbay-rewards' ); ?>
								<code><?php echo esc_html( (string) ( $settings['webhook_secret'] ?? '' ) ); ?></code>
							</p>
							<label>
								<input type="checkbox" name="<?php echo esc_attr( self::OPTION ); ?>[regenerate_webhook_secret]" value="1">
								<?php esc_html_e( 'Generate a new signing secret on save', 'tbay-rewards' ); ?>
							</label>
						</td>
					</tr>
				</table>

				<h2 class="title"><?php esc_html_e( 'Tracking', 'tbay-rewards' ); ?></h2>
				<table class="form-table" role="presentation">
					<?php
					$this->checkbox_row( 'enable_tracking', __( 'Enable visitor tracking', 'tbay-rewards' ), __( 'Pageviews, traffic sources, product engagement and carts.', 'tbay-rewards' ), $settings );
					$this->checkbox_row( 'enable_heatmaps', __( 'Record heatmaps', 'tbay-rewards' ), __( 'Clicks, pointer movement and scroll depth, aggregated into a grid. No cursor traces are stored.', 'tbay-rewards' ), $settings );
					$this->checkbox_row( 'require_consent', __( 'Wait for consent', 'tbay-rewards' ), __( 'Collect nothing until your consent banner calls tbay.consent(true).', 'tbay-rewards' ), $settings );
					$this->checkbox_row( 'enable_commerce', __( 'Sync WooCommerce', 'tbay-rewards' ), __( 'Carts, orders, refunds and store credit.', 'tbay-rewards' ), $settings );
					?>
				</table>

				<h2 class="title"><?php esc_html_e( 'Rewards', 'tbay-rewards' ); ?></h2>
				<table class="form-table" role="presentation">
					<?php $this->checkbox_row( 'enable_rewards', __( 'Enable rewards and TBAY redemption', 'tbay-rewards' ), '', $settings ); ?>
					<tr>
						<th scope="row">
							<label for="tbay-writer-rate"><?php esc_html_e( 'Writer commission', 'tbay-rewards' ); ?></label>
						</th>
						<td>
							<input type="number" id="tbay-writer-rate" class="small-text" min="0" max="10000" step="25"
								name="<?php echo esc_attr( self::OPTION ); ?>[writer_rate_bps]"
								value="<?php echo esc_attr( (string) ( $settings['writer_rate_bps'] ?? 500 ) ); ?>">
							<span class="description">
								<?php esc_html_e( 'basis points — 500 = 5% of what a blog link sells.', 'tbay-rewards' ); ?>
							</span>
						</td>
					</tr>
				</table>

				<?php if ( function_exists( 'mycred' ) || class_exists( 'myCRED_Core' ) ) : ?>
					<h2 class="title"><?php esc_html_e( 'myCred', 'tbay-rewards' ); ?></h2>
					<table class="form-table" role="presentation">
						<?php $this->checkbox_row( 'mycred_sync', __( 'Mirror points into myCred', 'tbay-rewards' ), __( 'TBAY Rewards stays the system of record; myCred reflects the balance for badges and ranks.', 'tbay-rewards' ), $settings ); ?>
						<tr>
							<th scope="row">
								<label for="tbay-mycred-type"><?php esc_html_e( 'Point type', 'tbay-rewards' ); ?></label>
							</th>
							<td>
								<input type="text" id="tbay-mycred-type" class="regular-text code"
									name="<?php echo esc_attr( self::OPTION ); ?>[mycred_point_type]"
									value="<?php echo esc_attr( (string) ( $settings['mycred_point_type'] ?? 'mycred_default' ) ); ?>">
							</td>
						</tr>
					</table>
				<?php endif; ?>

				<?php submit_button(); ?>
			</form>

			<h2 class="title"><?php esc_html_e( 'Shortcodes', 'tbay-rewards' ); ?></h2>
			<table class="widefat striped">
				<tbody>
					<tr><td><code>[tbay_newsletter]</code></td><td><?php esc_html_e( 'Newsletter signup form with double opt-in.', 'tbay-rewards' ); ?></td></tr>
					<tr><td><code>[tbay_rewards]</code></td><td><?php esc_html_e( 'Member dashboard: balance, wallet, TBAY redemption and history.', 'tbay-rewards' ); ?></td></tr>
					<tr><td><code>[tbay_points]</code></td><td><?php esc_html_e( 'Just the point balance, for a header or menu.', 'tbay-rewards' ); ?></td></tr>
					<tr><td><code>[tbay_share]</code></td><td><?php esc_html_e( 'Share buttons that award points once the shared link is clicked.', 'tbay-rewards' ); ?></td></tr>
					<tr><td><code>[tbay_link product="123"]…[/tbay_link]</code></td><td><?php esc_html_e( 'A tracked product link that earns the post author commission.', 'tbay-rewards' ); ?></td></tr>
				</tbody>
			</table>
		</div>
		<?php
	}

	/**
	 * @param array<string,mixed> $settings Current settings.
	 */
	private function checkbox_row( string $key, string $label, string $description, array $settings ): void {
		?>
		<tr>
			<th scope="row"><?php echo esc_html( $label ); ?></th>
			<td>
				<label>
					<input type="checkbox" name="<?php echo esc_attr( self::OPTION . '[' . $key . ']' ); ?>" value="1"
						<?php checked( ! empty( $settings[ $key ] ) ); ?>>
					<?php esc_html_e( 'Enabled', 'tbay-rewards' ); ?>
				</label>
				<?php if ( '' !== $description ) : ?>
					<p class="description"><?php echo esc_html( $description ); ?></p>
				<?php endif; ?>
			</td>
		</tr>
		<?php
	}
}
