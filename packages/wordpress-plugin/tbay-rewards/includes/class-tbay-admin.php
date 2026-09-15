<?php
/**
 * In-dashboard reporting.
 *
 * @package TBAY_Rewards
 */

declare( strict_types = 1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * A summary of the platform's reports inside wp-admin, so a shop owner does not
 * have to leave WordPress for the everyday numbers.
 */
class TBAY_Rewards_Admin {

	public function __construct( private TBAY_Rewards_API $api ) {
		add_action( 'admin_menu', array( $this, 'add_page' ) );
		add_action( 'wp_dashboard_setup', array( $this, 'add_dashboard_widget' ) );
	}

	public function add_page(): void {
		add_menu_page(
			__( 'TBAY Rewards', 'tbay-rewards' ),
			__( 'TBAY Rewards', 'tbay-rewards' ),
			'manage_options',
			'tbay-rewards-reports',
			array( $this, 'render' ),
			'dashicons-chart-area',
			58
		);
	}

	public function add_dashboard_widget(): void {
		if ( ! current_user_can( 'manage_options' ) || ! $this->api->is_configured() ) {
			return;
		}

		wp_add_dashboard_widget(
			'tbay_rewards_overview',
			__( 'TBAY Rewards', 'tbay-rewards' ),
			array( $this, 'render_widget' )
		);
	}

	public function render_widget(): void {
		$overview = $this->api->get_cached( '/v1/reports/overview', array(), 300 );
		if ( is_wp_error( $overview ) ) {
			printf( '<p>%s</p>', esc_html__( 'Reports are unavailable right now.', 'tbay-rewards' ) );
			return;
		}

		$stats = is_array( $overview['overview'] ?? null ) ? $overview['overview'] : array();
		?>
		<ul class="tbay-widget-stats">
			<li><strong><?php echo esc_html( number_format_i18n( (int) ( $stats['sessions'] ?? 0 ) ) ); ?></strong> <?php esc_html_e( 'sessions (30 days)', 'tbay-rewards' ); ?></li>
			<li><strong><?php echo esc_html( number_format_i18n( (int) ( $stats['orders'] ?? 0 ) ) ); ?></strong> <?php esc_html_e( 'orders', 'tbay-rewards' ); ?></li>
			<li><strong><?php echo esc_html( number_format_i18n( (int) ( $stats['subscribers'] ?? 0 ) ) ); ?></strong> <?php esc_html_e( 'subscribers', 'tbay-rewards' ); ?></li>
			<li><strong><?php echo esc_html( number_format_i18n( (int) ( $stats['points_awarded'] ?? 0 ) ) ); ?></strong> <?php esc_html_e( 'points issued', 'tbay-rewards' ); ?></li>
		</ul>
		<p>
			<a href="<?php echo esc_url( admin_url( 'admin.php?page=tbay-rewards-reports' ) ); ?>">
				<?php esc_html_e( 'View full reports', 'tbay-rewards' ); ?>
			</a>
		</p>
		<?php
	}

	public function render(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to view these reports.', 'tbay-rewards' ) );
		}

		if ( ! $this->api->is_configured() ) {
			printf(
				'<div class="wrap"><h1>%s</h1><p>%s</p></div>',
				esc_html__( 'TBAY Rewards', 'tbay-rewards' ),
				sprintf(
					/* translators: %s: settings page link. */
					wp_kses_post( __( 'Connect the plugin to your rewards platform in <a href="%s">Settings → TBAY Rewards</a>.', 'tbay-rewards' ) ),
					esc_url( admin_url( 'options-general.php?page=tbay-rewards' ) )
				)
			);
			return;
		}

		$overview = $this->api->get_cached( '/v1/reports/overview', array(), 300 );
		$sources  = $this->api->get_cached( '/v1/reports/sources', array( 'limit' => 10 ), 300 );
		$products = $this->api->get_cached( '/v1/reports/products', array( 'limit' => 10 ), 300 );
		$carts    = $this->api->get_cached( '/v1/reports/carts', array(), 300 );
		$blog     = $this->api->get_cached( '/v1/reports/blog-links', array( 'limit' => 10 ), 300 );
		$rewards  = $this->api->get_cached( '/v1/reports/rewards', array(), 300 );

		$stats      = is_wp_error( $overview ) ? array() : ( $overview['overview'] ?? array() );
		$cart_stats = is_wp_error( $carts ) ? array() : ( $carts['carts'] ?? array() );
		$reward     = is_wp_error( $rewards ) ? array() : ( $rewards['rewards'] ?? array() );
		?>
		<div class="wrap tbay-reports">
			<h1><?php esc_html_e( 'TBAY Rewards', 'tbay-rewards' ); ?></h1>
			<p class="description"><?php esc_html_e( 'Last 30 days.', 'tbay-rewards' ); ?></p>

			<div class="tbay-report-cards">
				<?php
				$this->card( __( 'Sessions', 'tbay-rewards' ), number_format_i18n( (int) ( $stats['sessions'] ?? 0 ) ) );
				$this->card( __( 'Visitors', 'tbay-rewards' ), number_format_i18n( (int) ( $stats['visitors'] ?? 0 ) ) );
				$this->card( __( 'Orders', 'tbay-rewards' ), number_format_i18n( (int) ( $stats['orders'] ?? 0 ) ) );
				$this->card( __( 'Revenue', 'tbay-rewards' ), $this->money( (int) ( $stats['revenue_cents'] ?? 0 ) ) );
				$this->card( __( 'Subscribers', 'tbay-rewards' ), number_format_i18n( (int) ( $stats['subscribers'] ?? 0 ) ) );
				$this->card( __( 'Points issued', 'tbay-rewards' ), number_format_i18n( (int) ( $stats['points_awarded'] ?? 0 ) ) );
				?>
			</div>

			<h2><?php esc_html_e( 'Abandoned carts', 'tbay-rewards' ); ?></h2>
			<div class="tbay-report-cards">
				<?php
				$this->card( __( 'Abandoned', 'tbay-rewards' ), number_format_i18n( (int) ( $cart_stats['abandoned'] ?? 0 ) ), $this->money( (int) ( $cart_stats['abandoned_value_cents'] ?? 0 ) ) . ' ' . __( 'at risk', 'tbay-rewards' ) );
				$this->card( __( 'Recovered', 'tbay-rewards' ), number_format_i18n( (int) ( $cart_stats['recovered'] ?? 0 ) ), $this->money( (int) ( $cart_stats['recovered_value_cents'] ?? 0 ) ) . ' ' . __( 'won back', 'tbay-rewards' ) );
				$this->card( __( 'Abandonment rate', 'tbay-rewards' ), $this->percent( (float) ( $cart_stats['abandonment_rate'] ?? 0 ) ) );
				$this->card( __( 'Recovery rate', 'tbay-rewards' ), $this->percent( (float) ( $cart_stats['recovery_rate'] ?? 0 ) ) );
				?>
			</div>

			<h2><?php esc_html_e( 'Where customers came from', 'tbay-rewards' ); ?></h2>
			<?php
			$this->table(
				array(
					__( 'Source', 'tbay-rewards' ),
					__( 'Medium', 'tbay-rewards' ),
					__( 'Sessions', 'tbay-rewards' ),
					__( 'Orders', 'tbay-rewards' ),
					__( 'Revenue', 'tbay-rewards' ),
				),
				array_map(
					fn( array $row ): array => array(
						(string) ( $row['source'] ?? '' ),
						(string) ( $row['medium'] ?? '—' ),
						number_format_i18n( (int) ( $row['sessions'] ?? 0 ) ),
						number_format_i18n( (int) ( $row['orders'] ?? 0 ) ),
						$this->money( (int) ( $row['revenue_cents'] ?? 0 ) ),
					),
					is_wp_error( $sources ) ? array() : ( $sources['sources'] ?? array() )
				),
				__( 'No traffic recorded yet.', 'tbay-rewards' )
			);
			?>

			<h2><?php esc_html_e( 'Most-clicked products', 'tbay-rewards' ); ?></h2>
			<?php
			$this->table(
				array(
					__( 'Product', 'tbay-rewards' ),
					__( 'Views', 'tbay-rewards' ),
					__( 'Clicks', 'tbay-rewards' ),
					__( 'Added to cart', 'tbay-rewards' ),
					__( 'Sold', 'tbay-rewards' ),
				),
				array_map(
					fn( array $row ): array => array(
						(string) ( $row['name'] ?? $row['product_ref'] ?? '' ),
						number_format_i18n( (int) ( $row['views'] ?? 0 ) ),
						number_format_i18n( (int) ( $row['clicks'] ?? 0 ) ),
						number_format_i18n( (int) ( $row['add_to_carts'] ?? 0 ) ),
						number_format_i18n( (int) ( $row['purchases'] ?? 0 ) ),
					),
					is_wp_error( $products ) ? array() : ( $products['products'] ?? array() )
				),
				__( 'No product engagement recorded yet.', 'tbay-rewards' )
			);
			?>

			<h2><?php esc_html_e( 'Blog links and writer commissions', 'tbay-rewards' ); ?></h2>
			<?php
			$this->table(
				array(
					__( 'Post', 'tbay-rewards' ),
					__( 'Writer', 'tbay-rewards' ),
					__( 'Clicks', 'tbay-rewards' ),
					__( 'Orders', 'tbay-rewards' ),
					__( 'Commission', 'tbay-rewards' ),
				),
				array_map(
					function ( array $row ): array {
						$post_ref = (string) ( $row['post_ref'] ?? '' );
						$title    = is_numeric( $post_ref ) ? (string) get_the_title( (int) $post_ref ) : $post_ref;
						return array(
							'' !== $title ? $title : ( (string) ( $row['label'] ?? '—' ) ),
							(string) ( $row['writer_name'] ?? '—' ),
							number_format_i18n( (int) ( $row['clicks'] ?? 0 ) ),
							number_format_i18n( (int) ( $row['orders'] ?? 0 ) ),
							$this->money( (int) ( $row['commission_cents'] ?? 0 ) ),
						);
					},
					is_wp_error( $blog ) ? array() : ( $blog['links'] ?? array() )
				),
				__( 'No writer links yet.', 'tbay-rewards' )
			);
			?>

			<h2><?php esc_html_e( 'Rewards and TBAY', 'tbay-rewards' ); ?></h2>
			<div class="tbay-report-cards">
				<?php
				$this->card( __( 'Members with points', 'tbay-rewards' ), number_format_i18n( (int) ( $reward['members_with_points'] ?? 0 ) ) );
				$this->card( __( 'Points outstanding', 'tbay-rewards' ), number_format_i18n( (int) ( $reward['total_balance'] ?? 0 ) ) );
				$this->card( __( 'TBAY claimed', 'tbay-rewards' ), $this->tokens( (string) ( $reward['tokens_claimed_wei'] ?? '0' ) ) );
				$this->card( __( 'Shares verified', 'tbay-rewards' ), number_format_i18n( (int) ( $reward['shares_verified'] ?? 0 ) ) );
				?>
			</div>

			<p>
				<a class="button" href="<?php echo esc_url( $this->api->endpoint() ); ?>" target="_blank" rel="noopener noreferrer">
					<?php esc_html_e( 'Open the full dashboard (heatmaps, funnels)', 'tbay-rewards' ); ?>
				</a>
			</p>
		</div>

		<style>
			.tbay-report-cards { display:flex; flex-wrap:wrap; gap:12px; margin:16px 0 24px; }
			.tbay-report-card { background:#fff; border:1px solid #c3c4c7; border-radius:6px; padding:14px 18px; min-width:150px; }
			.tbay-report-card__label { display:block; font-size:12px; color:#646970; text-transform:uppercase; letter-spacing:.04em; }
			.tbay-report-card__value { display:block; font-size:24px; font-weight:600; margin-top:4px; }
			.tbay-report-card__sub { display:block; font-size:12px; color:#646970; margin-top:2px; }
			.tbay-widget-stats { margin:0; }
			.tbay-widget-stats li { margin:0 0 4px; }
		</style>
		<?php
	}

	private function card( string $label, string $value, string $sub = '' ): void {
		printf(
			'<div class="tbay-report-card"><span class="tbay-report-card__label">%s</span><span class="tbay-report-card__value">%s</span>%s</div>',
			esc_html( $label ),
			esc_html( $value ),
			'' !== $sub ? '<span class="tbay-report-card__sub">' . esc_html( $sub ) . '</span>' : ''
		);
	}

	/**
	 * @param string[]   $headings Column headings.
	 * @param array<int, string[]> $rows Table rows.
	 */
	private function table( array $headings, array $rows, string $empty ): void {
		if ( empty( $rows ) ) {
			printf( '<p>%s</p>', esc_html( $empty ) );
			return;
		}
		?>
		<table class="widefat striped">
			<thead>
				<tr>
					<?php foreach ( $headings as $heading ) : ?>
						<th scope="col"><?php echo esc_html( $heading ); ?></th>
					<?php endforeach; ?>
				</tr>
			</thead>
			<tbody>
				<?php foreach ( $rows as $row ) : ?>
					<tr>
						<?php foreach ( $row as $cell ) : ?>
							<td><?php echo esc_html( $cell ); ?></td>
						<?php endforeach; ?>
					</tr>
				<?php endforeach; ?>
			</tbody>
		</table>
		<?php
	}

	private function money( int $cents ): string {
		if ( function_exists( 'wc_price' ) ) {
			return wp_strip_all_tags( (string) wc_price( $cents / 100 ) );
		}
		return number_format_i18n( $cents / 100, 2 );
	}

	private function percent( float $ratio ): string {
		return number_format_i18n( $ratio * 100, 1 ) . '%';
	}

	/** Format a uint256 wei string without overflowing a PHP int. */
	private function tokens( string $wei ): string {
		if ( ! ctype_digit( $wei ) || '' === $wei ) {
			return '0';
		}
		$padded = str_pad( $wei, 19, '0', STR_PAD_LEFT );
		$whole  = substr( $padded, 0, -18 );
		$frac   = rtrim( substr( $padded, -18, 4 ), '0' );
		return '' !== $frac ? $whole . '.' . $frac : $whole;
	}
}
