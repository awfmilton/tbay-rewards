<?php
/**
 * Admin screens for everything that was API-only.
 *
 * A parity review found the engine complete but most of it unreachable from
 * wp-admin: support could not look up a customer's history, adjust a balance,
 * create a badge, edit an email template or build a segment without an API
 * client. The capability existed; only the screens were missing.
 *
 * Every screen here is a thin view over the platform's REST API using the
 * tenant's secret key, which the site already holds. Nothing is cached beyond
 * what the API client does, because an admin looking at a balance needs the
 * balance, not one from five minutes ago.
 *
 * @package TBAY_Rewards
 */

defined( 'ABSPATH' ) || exit;

class TBAY_Rewards_Manage {

	private const CAPABILITY = 'manage_options';

	/** Screens, in menu order. */
	private const SCREENS = array(
		'customers'    => 'Customers',
		'ledger'       => 'Points ledger',
		'rules'        => 'Earning rules',
		'gamification' => 'Badges & ranks',
		'marketing'    => 'Segments & sends',
		'email'        => 'Email',
	);

	public function __construct( private TBAY_Rewards_API $api ) {
		add_action( 'admin_menu', array( $this, 'add_pages' ), 20 );
		add_action( 'admin_post_tbay_manage', array( $this, 'handle_post' ) );
		add_action( 'admin_enqueue_scripts', array( $this, 'enqueue' ) );
	}

	public function add_pages(): void {
		foreach ( self::SCREENS as $slug => $label ) {
			add_submenu_page(
				'tbay-rewards-reports',
				/* translators: %s: screen name */
				sprintf( __( 'TBAY %s', 'tbay-rewards' ), $label ),
				__( $label, 'tbay-rewards' ), // phpcs:ignore WordPress.WP.I18n
				self::CAPABILITY,
				'tbay-manage-' . $slug,
				array( $this, 'render' )
			);
		}
	}

	public function enqueue( string $hook ): void {
		if ( ! str_contains( $hook, 'tbay-manage-' ) ) {
			return;
		}
		wp_enqueue_style(
			'tbay-manage',
			TBAY_REWARDS_URL . 'assets/tbay-admin.css',
			array(),
			TBAY_REWARDS_VERSION
		);
	}

	private function current_screen(): string {
		$page = isset( $_GET['page'] ) ? sanitize_key( wp_unslash( $_GET['page'] ) ) : '';
		$slug = str_replace( 'tbay-manage-', '', $page );
		return array_key_exists( $slug, self::SCREENS ) ? $slug : 'customers';
	}

	public function render(): void {
		if ( ! current_user_can( self::CAPABILITY ) ) {
			wp_die( esc_html__( 'You do not have permission to view this page.', 'tbay-rewards' ) );
		}

		$screen = $this->current_screen();

		echo '<div class="wrap tbay-manage">';
		printf(
			'<h1>%s</h1>',
			esc_html( __( 'TBAY ', 'tbay-rewards' ) . self::SCREENS[ $screen ] )
		);

		if ( ! $this->api->is_configured() ) {
			printf(
				'<div class="notice notice-warning"><p>%s <a href="%s">%s</a></p></div>',
				esc_html__( 'TBAY Rewards is not connected yet.', 'tbay-rewards' ),
				esc_url( admin_url( 'options-general.php?page=tbay-rewards' ) ),
				esc_html__( 'Add your API keys', 'tbay-rewards' )
			);
			echo '</div>';
			return;
		}

		$this->render_notice();

		switch ( $screen ) {
			case 'ledger':
				$this->screen_ledger();
				break;
			case 'rules':
				$this->screen_rules();
				break;
			case 'gamification':
				$this->screen_gamification();
				break;
			case 'marketing':
				$this->screen_marketing();
				break;
			case 'email':
				$this->screen_email();
				break;
			default:
				$this->screen_customers();
		}

		echo '</div>';
	}

	// ── Notices ──────────────────────────────────────────────────────────────

	/**
	 * Show the result of the last action.
	 *
	 * Carried in the redirect rather than kept in a transient so two admins
	 * working at once never see each other's messages.
	 */
	private function render_notice(): void {
		$message = isset( $_GET['tbay_msg'] ) ? sanitize_text_field( wp_unslash( $_GET['tbay_msg'] ) ) : '';
		if ( '' === $message ) {
			return;
		}
		$is_error = isset( $_GET['tbay_err'] ) && '1' === $_GET['tbay_err'];
		printf(
			'<div class="notice notice-%s is-dismissible"><p>%s</p></div>',
			$is_error ? 'error' : 'success',
			esc_html( $message )
		);
	}

	private function redirect_back( string $screen, string $message, bool $error = false, array $extra = array() ): void {
		$url = add_query_arg(
			array_merge(
				array(
					'page'     => 'tbay-manage-' . $screen,
					'tbay_msg' => rawurlencode( $message ),
					'tbay_err' => $error ? '1' : '0',
				),
				$extra
			),
			admin_url( 'admin.php' )
		);
		wp_safe_redirect( $url );
		exit;
	}

	// ── Form handling ────────────────────────────────────────────────────────

	/**
	 * One POST endpoint for every form on these screens.
	 *
	 * Capability and nonce are checked once, here, rather than in each handler
	 * — a new form added later cannot forget them.
	 */
	public function handle_post(): void {
		if ( ! current_user_can( self::CAPABILITY ) ) {
			wp_die( esc_html__( 'You do not have permission to do that.', 'tbay-rewards' ) );
		}
		check_admin_referer( 'tbay_manage' );

		$action = isset( $_POST['tbay_action'] ) ? sanitize_key( wp_unslash( $_POST['tbay_action'] ) ) : '';
		$screen = isset( $_POST['tbay_screen'] ) ? sanitize_key( wp_unslash( $_POST['tbay_screen'] ) ) : 'customers';

		$result = match ( $action ) {
			'adjust_points'    => $this->do_adjust_points(),
			'save_rule'        => $this->do_save_rule(),
			'add_exclusion'    => $this->do_add_exclusion(),
			'delete_exclusion' => $this->do_delete_exclusion(),
			'save_product_rule' => $this->do_save_product_rule(),
			'delete_product_rule' => $this->do_delete_product_rule(),
			'save_badge'       => $this->do_save_badge(),
			'save_rank'        => $this->do_save_rank(),
			'assign_rank'      => $this->do_assign_rank(),
			'reevaluate'       => $this->do_reevaluate(),
			'save_segment'     => $this->do_save_segment(),
			'build_segment'    => $this->do_build_segment(),
			'save_broadcast'   => $this->do_save_broadcast(),
			'send_broadcast'   => $this->do_send_broadcast(),
			'cancel_broadcast' => $this->do_cancel_broadcast(),
			'save_template'    => $this->do_save_template(),
			'suppress_email'   => $this->do_suppress_email(),
			'unsuppress_email' => $this->do_unsuppress_email(),
			default            => new WP_Error( 'tbay_unknown', __( 'Unknown action.', 'tbay-rewards' ) ),
		};

		if ( is_wp_error( $result ) ) {
			$this->redirect_back( $screen, $result->get_error_message(), true );
		}
		$this->redirect_back( $screen, is_string( $result ) ? $result : __( 'Saved.', 'tbay-rewards' ) );
	}

	private function post( string $key, string $default = '' ): string {
		return isset( $_POST[ $key ] ) ? sanitize_text_field( wp_unslash( $_POST[ $key ] ) ) : $default;
	}

	private function post_int( string $key, ?int $default = null ): ?int {
		if ( ! isset( $_POST[ $key ] ) || '' === $_POST[ $key ] ) {
			return $default;
		}
		return (int) $_POST[ $key ];
	}

	private function query( string $key, string $default = '' ): string {
		return isset( $_GET[ $key ] ) ? sanitize_text_field( wp_unslash( $_GET[ $key ] ) ) : $default;
	}

	// ── Customers ────────────────────────────────────────────────────────────

	private function screen_customers(): void {
		$email = $this->query( 'email' );

		$this->render_search_form( 'customers', $email, __( 'Customer email', 'tbay-rewards' ) );

		if ( '' === $email ) {
			printf(
				'<p class="description">%s</p>',
				esc_html__( 'Search for a customer to see everything that has happened to them.', 'tbay-rewards' )
			);
			return;
		}

		$data = $this->api->request( 'GET', '/v1/contacts/timeline', array(), array( 'email' => $email, 'limit' => 100 ) );
		if ( is_wp_error( $data ) ) {
			printf( '<div class="notice notice-error"><p>%s</p></div>', esc_html( $data->get_error_message() ) );
			return;
		}

		$contact = is_array( $data['contact'] ?? null ) ? $data['contact'] : array();
		$summary = is_array( $data['summary'] ?? null ) ? $data['summary'] : array();
		$timeline = is_array( $data['timeline'] ?? null ) ? $data['timeline'] : array();

		$this->render_summary_cards( $summary );
		$this->render_adjust_form( (string) ( $contact['id'] ?? '' ), $contact );
		$this->render_timeline( $timeline );
	}

	private function render_search_form( string $screen, string $value, string $label ): void {
		?>
		<form method="get" class="tbay-search">
			<input type="hidden" name="page" value="tbay-manage-<?php echo esc_attr( $screen ); ?>" />
			<label class="screen-reader-text" for="tbay-search-email"><?php echo esc_html( $label ); ?></label>
			<input type="search" id="tbay-search-email" name="email" value="<?php echo esc_attr( $value ); ?>"
				placeholder="<?php echo esc_attr( $label ); ?>" class="regular-text" />
			<?php submit_button( __( 'Look up', 'tbay-rewards' ), 'secondary', '', false ); ?>
		</form>
		<?php
	}

	private function render_summary_cards( array $summary ): void {
		$cards = array(
			__( 'Orders', 'tbay-rewards' )        => number_format_i18n( (int) ( $summary['orders'] ?? 0 ) ),
			__( 'Spent', 'tbay-rewards' )         => $this->money( (int) ( $summary['total_spent_cents'] ?? 0 ) ),
			__( 'Points', 'tbay-rewards' )        => number_format_i18n( (int) ( $summary['points_balance'] ?? 0 ) ),
			__( 'Earned ever', 'tbay-rewards' )   => number_format_i18n( (int) ( $summary['lifetime_points'] ?? 0 ) ),
			__( 'Emails sent', 'tbay-rewards' )   => number_format_i18n( (int) ( $summary['emails_sent'] ?? 0 ) ),
			__( 'Emails opened', 'tbay-rewards' ) => number_format_i18n( (int) ( $summary['emails_opened'] ?? 0 ) ),
			__( 'Visits', 'tbay-rewards' )        => number_format_i18n( (int) ( $summary['sessions'] ?? 0 ) ),
		);
		echo '<div class="tbay-cards">';
		foreach ( $cards as $label => $value ) {
			printf(
				'<div class="tbay-card"><span class="tbay-card__value">%s</span><span class="tbay-card__label">%s</span></div>',
				esc_html( $value ),
				esc_html( $label )
			);
		}
		echo '</div>';
	}

	private function render_adjust_form( string $contact_id, array $contact ): void {
		if ( '' === $contact_id ) {
			return;
		}
		?>
		<h2><?php esc_html_e( 'Adjust balance', 'tbay-rewards' ); ?></h2>
		<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" class="tbay-inline-form">
			<?php wp_nonce_field( 'tbay_manage' ); ?>
			<input type="hidden" name="action" value="tbay_manage" />
			<input type="hidden" name="tbay_action" value="adjust_points" />
			<input type="hidden" name="tbay_screen" value="customers" />
			<input type="hidden" name="contact_id" value="<?php echo esc_attr( $contact_id ); ?>" />
			<input type="hidden" name="email" value="<?php echo esc_attr( (string) ( $contact['email'] ?? '' ) ); ?>" />

			<label for="tbay-points"><?php esc_html_e( 'Points', 'tbay-rewards' ); ?></label>
			<input type="number" id="tbay-points" name="points" step="1" required class="small-text" />

			<label for="tbay-reason"><?php esc_html_e( 'Reason', 'tbay-rewards' ); ?></label>
			<input type="text" id="tbay-reason" name="reason" required class="regular-text"
				placeholder="<?php esc_attr_e( 'Goodwill after a delayed order', 'tbay-rewards' ); ?>" />

			<?php submit_button( __( 'Apply', 'tbay-rewards' ), 'primary', '', false ); ?>
			<p class="description">
				<?php esc_html_e( 'A negative number takes points away. Every adjustment is written to the ledger with your reason and cannot be edited afterwards.', 'tbay-rewards' ); ?>
			</p>
		</form>
		<?php
	}

	private function render_timeline( array $timeline ): void {
		echo '<h2>' . esc_html__( 'History', 'tbay-rewards' ) . '</h2>';

		if ( empty( $timeline ) ) {
			printf( '<p>%s</p>', esc_html__( 'Nothing recorded yet.', 'tbay-rewards' ) );
			return;
		}
		?>
		<table class="widefat striped tbay-timeline">
			<thead>
				<tr>
					<th><?php esc_html_e( 'When', 'tbay-rewards' ); ?></th>
					<th><?php esc_html_e( 'What', 'tbay-rewards' ); ?></th>
					<th><?php esc_html_e( 'Detail', 'tbay-rewards' ); ?></th>
					<th class="tbay-num"><?php esc_html_e( 'Amount', 'tbay-rewards' ); ?></th>
				</tr>
			</thead>
			<tbody>
			<?php foreach ( $timeline as $entry ) : ?>
				<tr>
					<td><?php echo esc_html( $this->when( (string) ( $entry['occurred_at'] ?? '' ) ) ); ?></td>
					<td>
						<span class="tbay-kind tbay-kind--<?php echo esc_attr( (string) ( $entry['kind'] ?? '' ) ); ?>">
							<?php echo esc_html( str_replace( '_', ' ', (string) ( $entry['kind'] ?? '' ) ) ); ?>
						</span>
						<?php echo esc_html( (string) ( $entry['title'] ?? '' ) ); ?>
					</td>
					<td><?php echo esc_html( (string) ( $entry['detail'] ?? '' ) ); ?></td>
					<td class="tbay-num"><?php echo esc_html( $this->amount( $entry ) ); ?></td>
				</tr>
			<?php endforeach; ?>
			</tbody>
		</table>
		<?php
	}

	/** Orders and carts are money; everything else is a count. */
	private function amount( array $entry ): string {
		$amount = $entry['amount'] ?? null;
		if ( null === $amount ) {
			return '';
		}
		$kind = (string) ( $entry['kind'] ?? '' );
		if ( in_array( $kind, array( 'order', 'cart_abandoned' ), true ) ) {
			return $this->money( (int) $amount );
		}
		return number_format_i18n( (int) $amount );
	}

	private function money( int $cents ): string {
		if ( function_exists( 'wc_price' ) ) {
			return wp_strip_all_tags( wc_price( $cents / 100 ) );
		}
		return number_format_i18n( $cents / 100, 2 );
	}

	private function when( string $iso ): string {
		if ( '' === $iso ) {
			return '';
		}
		$time = strtotime( $iso );
		if ( false === $time ) {
			return $iso;
		}
		return wp_date( get_option( 'date_format' ) . ' ' . get_option( 'time_format' ), $time );
	}

	private function do_adjust_points(): string|WP_Error {
		$contact_id = $this->post( 'contact_id' );
		$points     = $this->post_int( 'points', 0 );
		$reason     = $this->post( 'reason' );

		if ( '' === $contact_id || 0 === $points || '' === $reason ) {
			return new WP_Error( 'tbay_bad_input', __( 'A points amount and a reason are both required.', 'tbay-rewards' ) );
		}

		$result = $this->api->post(
			'/v1/rewards/adjust',
			array(
				'contactId' => $contact_id,
				'points'    => $points,
				'reason'    => $reason,
				// Unique per adjustment, so a double-submitted form cannot
				// apply the same correction twice.
				'idempotencyKey' => 'wpadmin-' . get_current_user_id() . '-' . wp_generate_uuid4(),
			)
		);

		if ( is_wp_error( $result ) ) {
			return $result;
		}
		return sprintf(
			/* translators: %s: number of points */
			__( 'Adjusted by %s points.', 'tbay-rewards' ),
			number_format_i18n( $points )
		);
	}

	// ── Ledger ───────────────────────────────────────────────────────────────

	private function screen_ledger(): void {
		$filters = array(
			'search'    => $this->query( 'search' ),
			'ruleKey'   => $this->query( 'ruleKey' ),
			'direction' => $this->query( 'direction' ),
			'from'      => $this->query( 'from' ),
			'to'        => $this->query( 'to' ),
			'limit'     => 100,
		);
		?>
		<form method="get" class="tbay-filters">
			<input type="hidden" name="page" value="tbay-manage-ledger" />
			<input type="search" name="search" value="<?php echo esc_attr( $filters['search'] ); ?>"
				placeholder="<?php esc_attr_e( 'Name, email or reason', 'tbay-rewards' ); ?>" class="regular-text" />
			<input type="text" name="ruleKey" value="<?php echo esc_attr( $filters['ruleKey'] ); ?>"
				placeholder="<?php esc_attr_e( 'Rule key', 'tbay-rewards' ); ?>" />
			<select name="direction">
				<option value=""><?php esc_html_e( 'Earned and spent', 'tbay-rewards' ); ?></option>
				<option value="credit" <?php selected( $filters['direction'], 'credit' ); ?>><?php esc_html_e( 'Earned only', 'tbay-rewards' ); ?></option>
				<option value="debit" <?php selected( $filters['direction'], 'debit' ); ?>><?php esc_html_e( 'Spent only', 'tbay-rewards' ); ?></option>
			</select>
			<input type="date" name="from" value="<?php echo esc_attr( $filters['from'] ); ?>" />
			<input type="date" name="to" value="<?php echo esc_attr( $filters['to'] ); ?>" />
			<?php submit_button( __( 'Filter', 'tbay-rewards' ), 'secondary', '', false ); ?>
		</form>
		<?php

		$data = $this->api->request( 'GET', '/v1/rewards/ledger', array(), $filters );
		if ( is_wp_error( $data ) ) {
			printf( '<div class="notice notice-error"><p>%s</p></div>', esc_html( $data->get_error_message() ) );
			return;
		}

		$entries = is_array( $data['entries'] ?? null ) ? $data['entries'] : array();
		printf(
			'<p class="description">%s</p>',
			esc_html(
				sprintf(
					/* translators: 1: rows shown, 2: total rows */
					__( 'Showing %1$s of %2$s entries. The ledger is append-only — a mistake is corrected with a reversal, which leaves both entries visible.', 'tbay-rewards' ),
					number_format_i18n( count( $entries ) ),
					number_format_i18n( (int) ( $data['total'] ?? 0 ) )
				)
			)
		);
		?>
		<table class="widefat striped">
			<thead>
				<tr>
					<th><?php esc_html_e( 'When', 'tbay-rewards' ); ?></th>
					<th><?php esc_html_e( 'Customer', 'tbay-rewards' ); ?></th>
					<th><?php esc_html_e( 'Reason', 'tbay-rewards' ); ?></th>
					<th><?php esc_html_e( 'Rule', 'tbay-rewards' ); ?></th>
					<th><?php esc_html_e( 'Status', 'tbay-rewards' ); ?></th>
					<th class="tbay-num"><?php esc_html_e( 'Points', 'tbay-rewards' ); ?></th>
				</tr>
			</thead>
			<tbody>
			<?php foreach ( $entries as $entry ) : ?>
				<tr>
					<td><?php echo esc_html( $this->when( (string) ( $entry['created_at'] ?? '' ) ) ); ?></td>
					<td>
						<?php
						$entry_email = (string) ( $entry['contact_email'] ?? '' );
						if ( '' !== $entry_email ) {
							printf(
								'<a href="%s">%s</a>',
								esc_url( admin_url( 'admin.php?page=tbay-manage-customers&email=' . rawurlencode( $entry_email ) ) ),
								esc_html( $entry_email )
							);
						} else {
							echo esc_html( (string) ( $entry['contact_name'] ?? '—' ) );
						}
						?>
					</td>
					<td><?php echo esc_html( (string) ( $entry['reason'] ?? '' ) ); ?></td>
					<td><code><?php echo esc_html( (string) ( $entry['rule_key'] ?? '' ) ); ?></code></td>
					<td><?php echo esc_html( (string) ( $entry['status'] ?? '' ) ); ?></td>
					<td class="tbay-num <?php echo (int) ( $entry['delta_points'] ?? 0 ) < 0 ? 'tbay-negative' : ''; ?>">
						<?php echo esc_html( number_format_i18n( (int) ( $entry['delta_points'] ?? 0 ) ) ); ?>
					</td>
				</tr>
			<?php endforeach; ?>
			</tbody>
		</table>
		<?php
	}

	// ── Earning rules ────────────────────────────────────────────────────────

	private function screen_rules(): void {
		$rules = $this->api->request( 'GET', '/v1/rewards/rules' );
		$rules = is_wp_error( $rules ) ? array() : ( $rules['rules'] ?? array() );

		echo '<h2>' . esc_html__( 'How customers earn', 'tbay-rewards' ) . '</h2>';
		?>
		<table class="widefat striped">
			<thead>
				<tr>
					<th><?php esc_html_e( 'Rule', 'tbay-rewards' ); ?></th>
					<th><?php esc_html_e( 'Points', 'tbay-rewards' ); ?></th>
					<th><?php esc_html_e( 'Caps', 'tbay-rewards' ); ?></th>
					<th><?php esc_html_e( 'On', 'tbay-rewards' ); ?></th>
					<th></th>
				</tr>
			</thead>
			<tbody>
			<?php foreach ( $rules as $rule ) : ?>
				<tr>
					<td>
						<strong><?php echo esc_html( (string) ( $rule['name'] ?? '' ) ); ?></strong><br />
						<code><?php echo esc_html( (string) ( $rule['key'] ?? '' ) ); ?></code>
					</td>
					<td>
						<?php
						echo 'per_currency_unit' === ( $rule['mode'] ?? '' )
							? esc_html( sprintf( /* translators: %s: points */ __( '%s per unit spent', 'tbay-rewards' ), (string) ( $rule['points_per_unit'] ?? '0' ) ) )
							: esc_html( number_format_i18n( (int) ( $rule['points'] ?? 0 ) ) );
						?>
					</td>
					<td><?php echo esc_html( $this->cap_summary( $rule ) ); ?></td>
					<td><?php echo ( $rule['enabled'] ?? false ) ? esc_html__( 'Yes', 'tbay-rewards' ) : esc_html__( 'No', 'tbay-rewards' ); ?></td>
					<td>
						<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" class="tbay-row-form">
							<?php wp_nonce_field( 'tbay_manage' ); ?>
							<input type="hidden" name="action" value="tbay_manage" />
							<input type="hidden" name="tbay_action" value="save_rule" />
							<input type="hidden" name="tbay_screen" value="rules" />
							<input type="hidden" name="key" value="<?php echo esc_attr( (string) ( $rule['key'] ?? '' ) ); ?>" />
							<input type="number" name="points" value="<?php echo esc_attr( (string) ( $rule['points'] ?? 0 ) ); ?>"
								class="small-text" aria-label="<?php esc_attr_e( 'Points', 'tbay-rewards' ); ?>" />
							<input type="number" name="dailyCap" value="<?php echo esc_attr( (string) ( $rule['daily_cap'] ?? '' ) ); ?>"
								class="small-text" placeholder="<?php esc_attr_e( 'Daily', 'tbay-rewards' ); ?>"
								aria-label="<?php esc_attr_e( 'Daily cap', 'tbay-rewards' ); ?>" />
							<label>
								<input type="checkbox" name="enabled" value="1" <?php checked( (bool) ( $rule['enabled'] ?? false ) ); ?> />
								<?php esc_html_e( 'On', 'tbay-rewards' ); ?>
							</label>
							<?php submit_button( __( 'Save', 'tbay-rewards' ), 'small', '', false ); ?>
						</form>
					</td>
				</tr>
			<?php endforeach; ?>
			</tbody>
		</table>
		<?php

		$this->render_exclusions();
		$this->render_product_rules();
	}

	private function cap_summary( array $rule ): string {
		$parts = array();
		foreach ( array( 'daily_cap' => 'day', 'weekly_cap' => 'week', 'monthly_cap' => 'month', 'lifetime_cap' => 'ever' ) as $field => $label ) {
			if ( null !== ( $rule[ $field ] ?? null ) ) {
				$parts[] = number_format_i18n( (int) $rule[ $field ] ) . '/' . $label;
			}
		}
		if ( null !== ( $rule['max_per_award'] ?? null ) ) {
			$parts[] = sprintf(
				/* translators: %s: points */
				__( 'max %s each', 'tbay-rewards' ),
				number_format_i18n( (int) $rule['max_per_award'] )
			);
		}
		return empty( $parts ) ? __( 'None', 'tbay-rewards' ) : implode( ', ', $parts );
	}

	private function render_exclusions(): void {
		$data = $this->api->request( 'GET', '/v1/rewards/exclusions' );
		$rows = is_wp_error( $data ) ? array() : ( $data['exclusions'] ?? array() );
		?>
		<h2><?php esc_html_e( 'Who does not earn', 'tbay-rewards' ); ?></h2>
		<p class="description">
			<?php esc_html_e( 'Staff and test accounts. Excluding someone stops them earning from now on; it never removes points they already have.', 'tbay-rewards' ); ?>
		</p>

		<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" class="tbay-inline-form">
			<?php wp_nonce_field( 'tbay_manage' ); ?>
			<input type="hidden" name="action" value="tbay_manage" />
			<input type="hidden" name="tbay_action" value="add_exclusion" />
			<input type="hidden" name="tbay_screen" value="rules" />
			<select name="kind" aria-label="<?php esc_attr_e( 'Exclusion type', 'tbay-rewards' ); ?>">
				<option value="email"><?php esc_html_e( 'Email address', 'tbay-rewards' ); ?></option>
				<option value="email_domain"><?php esc_html_e( 'Email domain', 'tbay-rewards' ); ?></option>
				<option value="role"><?php esc_html_e( 'WordPress role', 'tbay-rewards' ); ?></option>
				<option value="tag"><?php esc_html_e( 'Tag', 'tbay-rewards' ); ?></option>
			</select>
			<input type="text" name="value" required class="regular-text"
				placeholder="<?php esc_attr_e( 'staff@yourshop.com or administrator', 'tbay-rewards' ); ?>"
				aria-label="<?php esc_attr_e( 'Value', 'tbay-rewards' ); ?>" />
			<input type="text" name="note" class="regular-text"
				placeholder="<?php esc_attr_e( 'Why (optional)', 'tbay-rewards' ); ?>"
				aria-label="<?php esc_attr_e( 'Note', 'tbay-rewards' ); ?>" />
			<?php submit_button( __( 'Exclude', 'tbay-rewards' ), 'secondary', '', false ); ?>
		</form>

		<table class="widefat striped">
			<tbody>
			<?php foreach ( $rows as $row ) : ?>
				<tr>
					<td><code><?php echo esc_html( (string) ( $row['kind'] ?? '' ) ); ?></code></td>
					<td><?php echo esc_html( (string) ( $row['value'] ?? '' ) ); ?></td>
					<td><?php echo esc_html( (string) ( $row['note'] ?? '' ) ); ?></td>
					<td>
						<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" class="tbay-row-form">
							<?php wp_nonce_field( 'tbay_manage' ); ?>
							<input type="hidden" name="action" value="tbay_manage" />
							<input type="hidden" name="tbay_action" value="delete_exclusion" />
							<input type="hidden" name="tbay_screen" value="rules" />
							<input type="hidden" name="id" value="<?php echo esc_attr( (string) ( $row['id'] ?? '' ) ); ?>" />
							<?php submit_button( __( 'Remove', 'tbay-rewards' ), 'small link-delete', '', false ); ?>
						</form>
					</td>
				</tr>
			<?php endforeach; ?>
			</tbody>
		</table>
		<?php
	}

	private function render_product_rules(): void {
		$data = $this->api->request( 'GET', '/v1/rewards/product-rules' );
		$rows = is_wp_error( $data ) ? array() : ( $data['rules'] ?? array() );
		?>
		<h2><?php esc_html_e( 'Points on particular products', 'tbay-rewards' ); ?></h2>
		<p class="description">
			<?php esc_html_e( 'Double points on a range, none on gift cards, a flat amount per unit. Anything not listed earns the normal rate.', 'tbay-rewards' ); ?>
		</p>

		<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" class="tbay-inline-form">
			<?php wp_nonce_field( 'tbay_manage' ); ?>
			<input type="hidden" name="action" value="tbay_manage" />
			<input type="hidden" name="tbay_action" value="save_product_rule" />
			<input type="hidden" name="tbay_screen" value="rules" />
			<select name="matchKind" aria-label="<?php esc_attr_e( 'Match on', 'tbay-rewards' ); ?>">
				<option value="product"><?php esc_html_e( 'Product', 'tbay-rewards' ); ?></option>
				<option value="category"><?php esc_html_e( 'Category', 'tbay-rewards' ); ?></option>
			</select>
			<input type="text" name="matchValue" required
				placeholder="<?php esc_attr_e( 'Product or category reference', 'tbay-rewards' ); ?>"
				aria-label="<?php esc_attr_e( 'Reference', 'tbay-rewards' ); ?>" class="regular-text" />
			<select name="mode" aria-label="<?php esc_attr_e( 'What to do', 'tbay-rewards' ); ?>">
				<option value="multiplier"><?php esc_html_e( 'Multiply points by', 'tbay-rewards' ); ?></option>
				<option value="fixed"><?php esc_html_e( 'Flat points per unit', 'tbay-rewards' ); ?></option>
				<option value="exclude"><?php esc_html_e( 'Earn nothing', 'tbay-rewards' ); ?></option>
			</select>
			<input type="number" name="amount" step="0.1" min="0" class="small-text"
				placeholder="<?php esc_attr_e( 'Amount', 'tbay-rewards' ); ?>"
				aria-label="<?php esc_attr_e( 'Amount', 'tbay-rewards' ); ?>" />
			<?php submit_button( __( 'Add', 'tbay-rewards' ), 'secondary', '', false ); ?>
		</form>

		<table class="widefat striped">
			<tbody>
			<?php foreach ( $rows as $row ) : ?>
				<tr>
					<td><code><?php echo esc_html( (string) ( $row['match_kind'] ?? '' ) ); ?></code></td>
					<td><?php echo esc_html( (string) ( $row['match_value'] ?? '' ) ); ?></td>
					<td>
						<?php
						$mode = (string) ( $row['mode'] ?? '' );
						echo esc_html(
							match ( $mode ) {
								'multiplier' => sprintf( '× %s', (string) ( $row['multiplier'] ?? '1' ) ),
								'fixed'      => sprintf(
									/* translators: %s: points */
									__( '%s per unit', 'tbay-rewards' ),
									number_format_i18n( (int) ( $row['points'] ?? 0 ) )
								),
								default      => __( 'Earns nothing', 'tbay-rewards' ),
							}
						);
						?>
					</td>
					<td>
						<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" class="tbay-row-form">
							<?php wp_nonce_field( 'tbay_manage' ); ?>
							<input type="hidden" name="action" value="tbay_manage" />
							<input type="hidden" name="tbay_action" value="delete_product_rule" />
							<input type="hidden" name="tbay_screen" value="rules" />
							<input type="hidden" name="id" value="<?php echo esc_attr( (string) ( $row['id'] ?? '' ) ); ?>" />
							<?php submit_button( __( 'Remove', 'tbay-rewards' ), 'small link-delete', '', false ); ?>
						</form>
					</td>
				</tr>
			<?php endforeach; ?>
			</tbody>
		</table>
		<?php
	}

	private function do_save_rule(): string|WP_Error {
		$key = $this->post( 'key' );
		if ( '' === $key ) {
			return new WP_Error( 'tbay_bad_input', __( 'Which rule?', 'tbay-rewards' ) );
		}

		$result = $this->api->request(
			'PUT',
			'/v1/rewards/rules',
			array(
				'key'      => $key,
				'points'   => $this->post_int( 'points', 0 ),
				// An empty cap field means "no cap", which the API expresses
				// as null rather than zero.
				'dailyCap' => $this->post_int( 'dailyCap' ),
				'enabled'  => isset( $_POST['enabled'] ),
			)
		);
		return is_wp_error( $result ) ? $result : __( 'Rule saved.', 'tbay-rewards' );
	}

	private function do_add_exclusion(): string|WP_Error {
		$result = $this->api->post(
			'/v1/rewards/exclusions',
			array(
				'kind'  => $this->post( 'kind', 'email' ),
				'value' => $this->post( 'value' ),
				'note'  => $this->post( 'note' ),
			)
		);
		return is_wp_error( $result ) ? $result : __( 'Exclusion added.', 'tbay-rewards' );
	}

	private function do_delete_exclusion(): string|WP_Error {
		$result = $this->api->request( 'DELETE', '/v1/rewards/exclusions/' . rawurlencode( $this->post( 'id' ) ) );
		return is_wp_error( $result ) ? $result : __( 'Exclusion removed.', 'tbay-rewards' );
	}

	private function do_save_product_rule(): string|WP_Error {
		$mode   = $this->post( 'mode', 'multiplier' );
		$amount = isset( $_POST['amount'] ) ? (float) $_POST['amount'] : 0.0;

		$body = array(
			'matchKind'  => $this->post( 'matchKind', 'product' ),
			'matchValue' => $this->post( 'matchValue' ),
			'mode'       => $mode,
		);
		if ( 'multiplier' === $mode ) {
			$body['multiplier'] = $amount > 0 ? $amount : 1;
		} elseif ( 'fixed' === $mode ) {
			$body['points'] = (int) $amount;
		}

		$result = $this->api->post( '/v1/rewards/product-rules', $body );
		return is_wp_error( $result ) ? $result : __( 'Product rule saved.', 'tbay-rewards' );
	}

	private function do_delete_product_rule(): string|WP_Error {
		$result = $this->api->request( 'DELETE', '/v1/rewards/product-rules/' . rawurlencode( $this->post( 'id' ) ) );
		return is_wp_error( $result ) ? $result : __( 'Product rule removed.', 'tbay-rewards' );
	}

	// ── Badges and ranks ─────────────────────────────────────────────────────

	private function screen_gamification(): void {
		$badges = $this->api->request( 'GET', '/v1/gamification/badges/admin' );
		$badges = is_wp_error( $badges ) ? array() : ( $badges['badges'] ?? array() );
		$ranks  = $this->api->request( 'GET', '/v1/gamification/ranks/admin' );
		$ranks  = is_wp_error( $ranks ) ? array() : ( $ranks['ranks'] ?? array() );
		?>
		<h2><?php esc_html_e( 'Badges', 'tbay-rewards' ); ?></h2>
		<table class="widefat striped">
			<thead><tr>
				<th><?php esc_html_e( 'Badge', 'tbay-rewards' ); ?></th>
				<th><?php esc_html_e( 'Earned by', 'tbay-rewards' ); ?></th>
				<th><?php esc_html_e( 'Tiers', 'tbay-rewards' ); ?></th>
				<th><?php esc_html_e( 'Points each', 'tbay-rewards' ); ?></th>
			</tr></thead>
			<tbody>
			<?php foreach ( $badges as $badge ) : ?>
				<tr>
					<td><strong><?php echo esc_html( (string) ( $badge['name'] ?? '' ) ); ?></strong><br />
						<code><?php echo esc_html( (string) ( $badge['key'] ?? '' ) ); ?></code></td>
					<td><?php echo esc_html( $this->criteria_summary( $badge['criteria'] ?? array() ) ); ?></td>
					<td><?php echo esc_html( (string) count( (array) ( $badge['tiers'] ?? array() ) ) ); ?></td>
					<td><?php echo esc_html( number_format_i18n( (int) ( $badge['points_per_tier'] ?? 0 ) ) ); ?></td>
				</tr>
			<?php endforeach; ?>
			</tbody>
		</table>

		<h3><?php esc_html_e( 'Add or update a badge', 'tbay-rewards' ); ?></h3>
		<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" class="tbay-inline-form">
			<?php wp_nonce_field( 'tbay_manage' ); ?>
			<input type="hidden" name="action" value="tbay_manage" />
			<input type="hidden" name="tbay_action" value="save_badge" />
			<input type="hidden" name="tbay_screen" value="gamification" />
			<input type="text" name="key" required placeholder="<?php esc_attr_e( 'key_like_this', 'tbay-rewards' ); ?>"
				aria-label="<?php esc_attr_e( 'Badge key', 'tbay-rewards' ); ?>" />
			<input type="text" name="name" required placeholder="<?php esc_attr_e( 'Badge name', 'tbay-rewards' ); ?>"
				class="regular-text" aria-label="<?php esc_attr_e( 'Badge name', 'tbay-rewards' ); ?>" />
			<select name="criteriaType" aria-label="<?php esc_attr_e( 'Earned by', 'tbay-rewards' ); ?>">
				<option value="order_count"><?php esc_html_e( 'Number of orders', 'tbay-rewards' ); ?></option>
				<option value="lifetime_points"><?php esc_html_e( 'Points earned', 'tbay-rewards' ); ?></option>
				<option value="referral_count"><?php esc_html_e( 'Referrals', 'tbay-rewards' ); ?></option>
				<option value="share_count"><?php esc_html_e( 'Shares', 'tbay-rewards' ); ?></option>
			</select>
			<input type="number" name="threshold" min="1" required class="small-text"
				placeholder="<?php esc_attr_e( 'How many', 'tbay-rewards' ); ?>"
				aria-label="<?php esc_attr_e( 'Threshold', 'tbay-rewards' ); ?>" />
			<input type="number" name="pointsPerTier" min="0" class="small-text"
				placeholder="<?php esc_attr_e( 'Points', 'tbay-rewards' ); ?>"
				aria-label="<?php esc_attr_e( 'Points for earning it', 'tbay-rewards' ); ?>" />
			<?php submit_button( __( 'Save badge', 'tbay-rewards' ), 'secondary', '', false ); ?>
		</form>

		<h2><?php esc_html_e( 'Ranks', 'tbay-rewards' ); ?></h2>
		<table class="widefat striped">
			<thead><tr>
				<th><?php esc_html_e( 'Rank', 'tbay-rewards' ); ?></th>
				<th><?php esc_html_e( 'From', 'tbay-rewards' ); ?></th>
				<th><?php esc_html_e( 'To', 'tbay-rewards' ); ?></th>
			</tr></thead>
			<tbody>
			<?php foreach ( $ranks as $rank ) : ?>
				<tr>
					<td><strong><?php echo esc_html( (string) ( $rank['name'] ?? '' ) ); ?></strong><br />
						<code><?php echo esc_html( (string) ( $rank['key'] ?? '' ) ); ?></code></td>
					<td><?php echo esc_html( number_format_i18n( (int) ( $rank['min_points'] ?? 0 ) ) ); ?></td>
					<td><?php echo null === ( $rank['max_points'] ?? null )
						? esc_html__( 'and up', 'tbay-rewards' )
						: esc_html( number_format_i18n( (int) $rank['max_points'] ) ); ?></td>
				</tr>
			<?php endforeach; ?>
			</tbody>
		</table>

		<h3><?php esc_html_e( 'Add or update a rank', 'tbay-rewards' ); ?></h3>
		<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" class="tbay-inline-form">
			<?php wp_nonce_field( 'tbay_manage' ); ?>
			<input type="hidden" name="action" value="tbay_manage" />
			<input type="hidden" name="tbay_action" value="save_rank" />
			<input type="hidden" name="tbay_screen" value="gamification" />
			<input type="text" name="key" required placeholder="<?php esc_attr_e( 'key_like_this', 'tbay-rewards' ); ?>"
				aria-label="<?php esc_attr_e( 'Rank key', 'tbay-rewards' ); ?>" />
			<input type="text" name="name" required placeholder="<?php esc_attr_e( 'Rank name', 'tbay-rewards' ); ?>"
				class="regular-text" aria-label="<?php esc_attr_e( 'Rank name', 'tbay-rewards' ); ?>" />
			<input type="number" name="minPoints" min="0" required class="small-text"
				placeholder="<?php esc_attr_e( 'From', 'tbay-rewards' ); ?>"
				aria-label="<?php esc_attr_e( 'Minimum points', 'tbay-rewards' ); ?>" />
			<input type="number" name="maxPoints" min="0" class="small-text"
				placeholder="<?php esc_attr_e( 'To (optional)', 'tbay-rewards' ); ?>"
				aria-label="<?php esc_attr_e( 'Maximum points', 'tbay-rewards' ); ?>" />
			<?php submit_button( __( 'Save rank', 'tbay-rewards' ), 'secondary', '', false ); ?>
		</form>

		<h3><?php esc_html_e( 'Recalculate everyone', 'tbay-rewards' ); ?></h3>
		<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
			<?php wp_nonce_field( 'tbay_manage' ); ?>
			<input type="hidden" name="action" value="tbay_manage" />
			<input type="hidden" name="tbay_action" value="reevaluate" />
			<input type="hidden" name="tbay_screen" value="gamification" />
			<p class="description">
				<?php esc_html_e( 'Run this after changing a threshold or importing balances. It is safe to repeat, and may take a while on a large customer list.', 'tbay-rewards' ); ?>
			</p>
			<?php submit_button( __( 'Recalculate badges and ranks', 'tbay-rewards' ), 'secondary', '', false ); ?>
		</form>
		<?php
	}

	private function criteria_summary( array $criteria ): string {
		$type = (string) ( $criteria['type'] ?? '' );
		if ( 'compound' === $type ) {
			$count = count( (array) ( $criteria['requires'] ?? array() ) );
			return sprintf(
				/* translators: 1: number of conditions, 2: all or any */
				__( '%1$d conditions, %2$s', 'tbay-rewards' ),
				$count,
				'or' === ( $criteria['compare'] ?? 'and' ) ? __( 'any', 'tbay-rewards' ) : __( 'all', 'tbay-rewards' )
			);
		}
		return '' === $type ? __( 'Given by hand', 'tbay-rewards' ) : str_replace( '_', ' ', $type );
	}

	private function do_save_badge(): string|WP_Error {
		$result = $this->api->request(
			'PUT',
			'/v1/gamification/badges/' . rawurlencode( $this->post( 'key' ) ),
			array(
				'name'          => $this->post( 'name' ),
				'criteria'      => array( 'type' => $this->post( 'criteriaType', 'order_count' ) ),
				'tiers'         => array(
					array( 'level' => 1, 'threshold' => max( 1, (int) $this->post_int( 'threshold', 1 ) ) ),
				),
				'pointsPerTier' => $this->post_int( 'pointsPerTier', 0 ),
			)
		);
		return is_wp_error( $result ) ? $result : __( 'Badge saved.', 'tbay-rewards' );
	}

	private function do_save_rank(): string|WP_Error {
		$result = $this->api->request(
			'PUT',
			'/v1/gamification/ranks/' . rawurlencode( $this->post( 'key' ) ),
			array(
				'name'      => $this->post( 'name' ),
				'minPoints' => $this->post_int( 'minPoints', 0 ),
				'maxPoints' => $this->post_int( 'maxPoints' ),
			)
		);
		return is_wp_error( $result ) ? $result : __( 'Rank saved.', 'tbay-rewards' );
	}

	private function do_assign_rank(): string|WP_Error {
		$result = $this->api->post(
			'/v1/gamification/ranks/assign',
			array( 'contactId' => $this->post( 'contact_id' ), 'rankKey' => $this->post( 'rank_key' ) )
		);
		return is_wp_error( $result ) ? $result : __( 'Rank assigned.', 'tbay-rewards' );
	}

	private function do_reevaluate(): string|WP_Error {
		$result = $this->api->post( '/v1/gamification/reevaluate', array() );
		if ( is_wp_error( $result ) ) {
			return $result;
		}
		return sprintf(
			/* translators: %s: number of customers */
			__( 'Recalculated %s customers.', 'tbay-rewards' ),
			number_format_i18n( (int) ( $result['contacts'] ?? 0 ) )
		);
	}

	// ── Segments and broadcasts ──────────────────────────────────────────────

	private function screen_marketing(): void {
		$segments = $this->api->request( 'GET', '/v1/segments' );
		$segments = is_wp_error( $segments ) ? array() : ( $segments['segments'] ?? array() );
		$sends    = $this->api->request( 'GET', '/v1/broadcasts' );
		$sends    = is_wp_error( $sends ) ? array() : ( $sends['broadcasts'] ?? array() );
		?>
		<h2><?php esc_html_e( 'Segments', 'tbay-rewards' ); ?></h2>
		<table class="widefat striped">
			<thead><tr>
				<th><?php esc_html_e( 'Segment', 'tbay-rewards' ); ?></th>
				<th class="tbay-num"><?php esc_html_e( 'People', 'tbay-rewards' ); ?></th>
				<th><?php esc_html_e( 'Last built', 'tbay-rewards' ); ?></th>
				<th></th>
			</tr></thead>
			<tbody>
			<?php foreach ( $segments as $segment ) : ?>
				<tr>
					<td>
						<strong><?php echo esc_html( (string) ( $segment['name'] ?? '' ) ); ?></strong><br />
						<code><?php echo esc_html( (string) ( $segment['key'] ?? '' ) ); ?></code>
						<?php if ( ! empty( $segment['build_error'] ) ) : ?>
							<br /><span class="tbay-error"><?php echo esc_html( (string) $segment['build_error'] ); ?></span>
						<?php endif; ?>
					</td>
					<td class="tbay-num"><?php echo esc_html( number_format_i18n( (int) ( $segment['member_count'] ?? 0 ) ) ); ?></td>
					<td><?php echo esc_html( $this->when( (string) ( $segment['last_built_at'] ?? '' ) ) ); ?></td>
					<td>
						<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" class="tbay-row-form">
							<?php wp_nonce_field( 'tbay_manage' ); ?>
							<input type="hidden" name="action" value="tbay_manage" />
							<input type="hidden" name="tbay_action" value="build_segment" />
							<input type="hidden" name="tbay_screen" value="marketing" />
							<input type="hidden" name="key" value="<?php echo esc_attr( (string) ( $segment['key'] ?? '' ) ); ?>" />
							<?php submit_button( __( 'Rebuild', 'tbay-rewards' ), 'small', '', false ); ?>
						</form>
					</td>
				</tr>
			<?php endforeach; ?>
			</tbody>
		</table>

		<h3><?php esc_html_e( 'Add a segment', 'tbay-rewards' ); ?></h3>
		<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" class="tbay-inline-form">
			<?php wp_nonce_field( 'tbay_manage' ); ?>
			<input type="hidden" name="action" value="tbay_manage" />
			<input type="hidden" name="tbay_action" value="save_segment" />
			<input type="hidden" name="tbay_screen" value="marketing" />
			<input type="text" name="key" required placeholder="<?php esc_attr_e( 'key_like_this', 'tbay-rewards' ); ?>"
				aria-label="<?php esc_attr_e( 'Segment key', 'tbay-rewards' ); ?>" />
			<input type="text" name="name" required placeholder="<?php esc_attr_e( 'Segment name', 'tbay-rewards' ); ?>"
				class="regular-text" aria-label="<?php esc_attr_e( 'Segment name', 'tbay-rewards' ); ?>" />
			<select name="field" aria-label="<?php esc_attr_e( 'Field', 'tbay-rewards' ); ?>">
				<option value="order_count"><?php esc_html_e( 'Number of orders', 'tbay-rewards' ); ?></option>
				<option value="total_spent_cents"><?php esc_html_e( 'Total spent, in cents', 'tbay-rewards' ); ?></option>
				<option value="points_balance"><?php esc_html_e( 'Points balance', 'tbay-rewards' ); ?></option>
				<option value="last_order_at"><?php esc_html_e( 'Days since last order', 'tbay-rewards' ); ?></option>
				<option value="last_opened_email_at"><?php esc_html_e( 'Days since opened an email', 'tbay-rewards' ); ?></option>
			</select>
			<select name="operator" aria-label="<?php esc_attr_e( 'Comparison', 'tbay-rewards' ); ?>">
				<option value="gte"><?php esc_html_e( 'at least', 'tbay-rewards' ); ?></option>
				<option value="lte"><?php esc_html_e( 'at most', 'tbay-rewards' ); ?></option>
				<option value="in_last_days"><?php esc_html_e( 'within the last (days)', 'tbay-rewards' ); ?></option>
				<option value="not_in_last_days"><?php esc_html_e( 'not within the last (days)', 'tbay-rewards' ); ?></option>
			</select>
			<input type="number" name="value" required class="small-text"
				aria-label="<?php esc_attr_e( 'Value', 'tbay-rewards' ); ?>" />
			<?php submit_button( __( 'Create segment', 'tbay-rewards' ), 'secondary', '', false ); ?>
			<p class="description">
				<?php esc_html_e( 'A simple one-condition segment. Anything more complex can be built through the API, and the segment will still appear here.', 'tbay-rewards' ); ?>
			</p>
		</form>

		<h2><?php esc_html_e( 'Sends', 'tbay-rewards' ); ?></h2>
		<table class="widefat striped">
			<thead><tr>
				<th><?php esc_html_e( 'Send', 'tbay-rewards' ); ?></th>
				<th><?php esc_html_e( 'Status', 'tbay-rewards' ); ?></th>
				<th class="tbay-num"><?php esc_html_e( 'Queued', 'tbay-rewards' ); ?></th>
				<th class="tbay-num"><?php esc_html_e( 'Skipped', 'tbay-rewards' ); ?></th>
				<th></th>
			</tr></thead>
			<tbody>
			<?php foreach ( $sends as $send ) : ?>
				<tr>
					<td><strong><?php echo esc_html( (string) ( $send['name'] ?? '' ) ); ?></strong><br />
						<code><?php echo esc_html( (string) ( $send['key'] ?? '' ) ); ?></code></td>
					<td><?php echo esc_html( (string) ( $send['status'] ?? '' ) ); ?></td>
					<td class="tbay-num"><?php echo esc_html( number_format_i18n( (int) ( $send['queued_count'] ?? 0 ) ) ); ?></td>
					<td class="tbay-num"><?php echo esc_html( number_format_i18n( (int) ( $send['skipped_count'] ?? 0 ) ) ); ?></td>
					<td>
						<?php if ( in_array( (string) ( $send['status'] ?? '' ), array( 'draft', 'scheduled' ), true ) ) : ?>
							<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" class="tbay-row-form"
								onsubmit="return confirm('<?php echo esc_js( __( 'Send this to the whole segment? This cannot be undone.', 'tbay-rewards' ) ); ?>');">
								<?php wp_nonce_field( 'tbay_manage' ); ?>
								<input type="hidden" name="action" value="tbay_manage" />
								<input type="hidden" name="tbay_action" value="send_broadcast" />
								<input type="hidden" name="tbay_screen" value="marketing" />
								<input type="hidden" name="key" value="<?php echo esc_attr( (string) ( $send['key'] ?? '' ) ); ?>" />
								<?php submit_button( __( 'Send now', 'tbay-rewards' ), 'small primary', '', false ); ?>
							</form>
						<?php elseif ( 'sending' === ( $send['status'] ?? '' ) ) : ?>
							<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" class="tbay-row-form">
								<?php wp_nonce_field( 'tbay_manage' ); ?>
								<input type="hidden" name="action" value="tbay_manage" />
								<input type="hidden" name="tbay_action" value="cancel_broadcast" />
								<input type="hidden" name="tbay_screen" value="marketing" />
								<input type="hidden" name="key" value="<?php echo esc_attr( (string) ( $send['key'] ?? '' ) ); ?>" />
								<?php submit_button( __( 'Stop', 'tbay-rewards' ), 'small link-delete', '', false ); ?>
							</form>
						<?php endif; ?>
					</td>
				</tr>
			<?php endforeach; ?>
			</tbody>
		</table>

		<h3><?php esc_html_e( 'Prepare a send', 'tbay-rewards' ); ?></h3>
		<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" class="tbay-inline-form">
			<?php wp_nonce_field( 'tbay_manage' ); ?>
			<input type="hidden" name="action" value="tbay_manage" />
			<input type="hidden" name="tbay_action" value="save_broadcast" />
			<input type="hidden" name="tbay_screen" value="marketing" />
			<input type="text" name="key" required placeholder="<?php esc_attr_e( 'key_like_this', 'tbay-rewards' ); ?>"
				aria-label="<?php esc_attr_e( 'Send key', 'tbay-rewards' ); ?>" />
			<input type="text" name="name" required placeholder="<?php esc_attr_e( 'What this send is', 'tbay-rewards' ); ?>"
				class="regular-text" aria-label="<?php esc_attr_e( 'Name', 'tbay-rewards' ); ?>" />
			<select name="segmentKey" aria-label="<?php esc_attr_e( 'Segment', 'tbay-rewards' ); ?>">
				<?php foreach ( $segments as $segment ) : ?>
					<option value="<?php echo esc_attr( (string) ( $segment['key'] ?? '' ) ); ?>">
						<?php echo esc_html( (string) ( $segment['name'] ?? '' ) ); ?>
					</option>
				<?php endforeach; ?>
			</select>
			<input type="text" name="templateKey" required placeholder="<?php esc_attr_e( 'Email template key', 'tbay-rewards' ); ?>"
				aria-label="<?php esc_attr_e( 'Template', 'tbay-rewards' ); ?>" />
			<?php submit_button( __( 'Save draft', 'tbay-rewards' ), 'secondary', '', false ); ?>
		</form>
		<?php
	}

	private function do_save_segment(): string|WP_Error {
		$value = $this->post( 'value' );
		$result = $this->api->request(
			'PUT',
			'/v1/segments/' . rawurlencode( $this->post( 'key' ) ),
			array(
				'name'       => $this->post( 'name' ),
				'definition' => array(
					'match'   => 'all',
					'filters' => array(
						array(
							'field'    => $this->post( 'field' ),
							'operator' => $this->post( 'operator' ),
							'value'    => is_numeric( $value ) ? (float) $value : $value,
						),
					),
				),
			)
		);
		return is_wp_error( $result ) ? $result : __( 'Segment saved. Rebuild it to fill in the members.', 'tbay-rewards' );
	}

	private function do_build_segment(): string|WP_Error {
		$result = $this->api->post( '/v1/segments/' . rawurlencode( $this->post( 'key' ) ) . '/build', array() );
		if ( is_wp_error( $result ) ) {
			return $result;
		}
		return sprintf(
			/* translators: %s: number of people */
			__( '%s people in that segment.', 'tbay-rewards' ),
			number_format_i18n( (int) ( $result['members'] ?? 0 ) )
		);
	}

	private function do_save_broadcast(): string|WP_Error {
		$result = $this->api->request(
			'PUT',
			'/v1/broadcasts/' . rawurlencode( $this->post( 'key' ) ),
			array(
				'name'        => $this->post( 'name' ),
				'segmentKey'  => $this->post( 'segmentKey' ),
				'templateKey' => $this->post( 'templateKey' ),
			)
		);
		return is_wp_error( $result ) ? $result : __( 'Draft saved.', 'tbay-rewards' );
	}

	private function do_send_broadcast(): string|WP_Error {
		$result = $this->api->post( '/v1/broadcasts/' . rawurlencode( $this->post( 'key' ) ) . '/send', array() );
		return is_wp_error( $result )
			? $result
			: __( 'Sending. It will work through the audience in the background.', 'tbay-rewards' );
	}

	private function do_cancel_broadcast(): string|WP_Error {
		$result = $this->api->post( '/v1/broadcasts/' . rawurlencode( $this->post( 'key' ) ) . '/cancel', array() );
		return is_wp_error( $result )
			? $result
			: __( 'Stopped. Anything already handed to the mail server will still go out.', 'tbay-rewards' );
	}

	// ── Email ────────────────────────────────────────────────────────────────

	private function screen_email(): void {
		$templates = $this->api->request( 'GET', '/v1/email/templates' );
		$templates = is_wp_error( $templates ) ? array() : ( $templates['templates'] ?? array() );
		$engagement = $this->api->request( 'GET', '/v1/email/engagement' );
		$engagement = is_wp_error( $engagement ) ? array() : ( $engagement['templates'] ?? array() );
		$suppressed = $this->api->request( 'GET', '/v1/email/suppressions' );
		$suppressed = is_wp_error( $suppressed ) ? array() : ( $suppressed['suppressions'] ?? array() );

		$editing = $this->query( 'template' );
		if ( '' !== $editing ) {
			$this->render_template_editor( $editing );
			return;
		}
		?>
		<h2><?php esc_html_e( 'Templates', 'tbay-rewards' ); ?></h2>
		<table class="widefat striped">
			<thead><tr>
				<th><?php esc_html_e( 'Template', 'tbay-rewards' ); ?></th>
				<th><?php esc_html_e( 'Subject', 'tbay-rewards' ); ?></th>
				<th><?php esc_html_e( 'Kind', 'tbay-rewards' ); ?></th>
				<th></th>
			</tr></thead>
			<tbody>
			<?php foreach ( $templates as $template ) : ?>
				<tr>
					<td><code><?php echo esc_html( (string) ( $template['key'] ?? '' ) ); ?></code>
						<?php if ( empty( $template['overridden'] ) ) : ?>
							<span class="description"><?php esc_html_e( '(built in)', 'tbay-rewards' ); ?></span>
						<?php endif; ?>
					</td>
					<td><?php echo esc_html( (string) ( $template['subject'] ?? '' ) ); ?></td>
					<td><?php echo ( $template['transactional'] ?? false )
						? esc_html__( 'Transactional', 'tbay-rewards' )
						: esc_html__( 'Marketing', 'tbay-rewards' ); ?></td>
					<td>
						<a href="<?php echo esc_url(
							admin_url( 'admin.php?page=tbay-manage-email&template=' . rawurlencode( (string) ( $template['key'] ?? '' ) ) )
						); ?>"><?php esc_html_e( 'Edit', 'tbay-rewards' ); ?></a>
					</td>
				</tr>
			<?php endforeach; ?>
			</tbody>
		</table>

		<h2><?php esc_html_e( 'How email is doing', 'tbay-rewards' ); ?></h2>
		<table class="widefat striped">
			<thead><tr>
				<th><?php esc_html_e( 'Template', 'tbay-rewards' ); ?></th>
				<th class="tbay-num"><?php esc_html_e( 'Sent', 'tbay-rewards' ); ?></th>
				<th class="tbay-num"><?php esc_html_e( 'Opened', 'tbay-rewards' ); ?></th>
				<th class="tbay-num"><?php esc_html_e( 'Clicked', 'tbay-rewards' ); ?></th>
			</tr></thead>
			<tbody>
			<?php foreach ( $engagement as $row ) : ?>
				<tr>
					<td><code><?php echo esc_html( (string) ( $row['template_key'] ?? '' ) ); ?></code></td>
					<td class="tbay-num"><?php echo esc_html( number_format_i18n( (int) ( $row['sent'] ?? 0 ) ) ); ?></td>
					<td class="tbay-num"><?php echo esc_html( sprintf( '%s%%', (string) ( $row['open_rate'] ?? 0 ) ) ); ?></td>
					<td class="tbay-num"><?php echo esc_html( sprintf( '%s%%', (string) ( $row['click_rate'] ?? 0 ) ) ); ?></td>
				</tr>
			<?php endforeach; ?>
			</tbody>
		</table>
		<p class="description">
			<?php esc_html_e( 'Transactional email is never tracked, so it shows no opens. Scanner and privacy-proxy opens are excluded from these numbers.', 'tbay-rewards' ); ?>
		</p>

		<h2><?php esc_html_e( 'Addresses we will not email', 'tbay-rewards' ); ?></h2>
		<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" class="tbay-inline-form">
			<?php wp_nonce_field( 'tbay_manage' ); ?>
			<input type="hidden" name="action" value="tbay_manage" />
			<input type="hidden" name="tbay_action" value="suppress_email" />
			<input type="hidden" name="tbay_screen" value="email" />
			<input type="email" name="email" required class="regular-text"
				placeholder="<?php esc_attr_e( 'address@example.com', 'tbay-rewards' ); ?>"
				aria-label="<?php esc_attr_e( 'Email address', 'tbay-rewards' ); ?>" />
			<?php submit_button( __( 'Stop emailing', 'tbay-rewards' ), 'secondary', '', false ); ?>
		</form>

		<table class="widefat striped">
			<tbody>
			<?php foreach ( $suppressed as $row ) : ?>
				<tr>
					<td><?php echo esc_html( (string) ( $row['email'] ?? '' ) ); ?></td>
					<td><?php echo esc_html( str_replace( '_', ' ', (string) ( $row['reason'] ?? '' ) ) ); ?></td>
					<td><?php echo esc_html( $this->when( (string) ( $row['created_at'] ?? '' ) ) ); ?></td>
					<td>
						<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" class="tbay-row-form">
							<?php wp_nonce_field( 'tbay_manage' ); ?>
							<input type="hidden" name="action" value="tbay_manage" />
							<input type="hidden" name="tbay_action" value="unsuppress_email" />
							<input type="hidden" name="tbay_screen" value="email" />
							<input type="hidden" name="email" value="<?php echo esc_attr( (string) ( $row['email'] ?? '' ) ); ?>" />
							<?php submit_button( __( 'Allow again', 'tbay-rewards' ), 'small link-delete', '', false ); ?>
						</form>
					</td>
				</tr>
			<?php endforeach; ?>
			</tbody>
		</table>
		<p class="description">
			<?php esc_html_e( 'Allowing an address again does not restore marketing consent — only the customer can give that back.', 'tbay-rewards' ); ?>
		</p>
		<?php
	}

	private function render_template_editor( string $key ): void {
		$data = $this->api->request( 'GET', '/v1/email/templates/' . rawurlencode( $key ) );
		if ( is_wp_error( $data ) ) {
			printf( '<div class="notice notice-error"><p>%s</p></div>', esc_html( $data->get_error_message() ) );
			return;
		}
		$template = is_array( $data['template'] ?? null ) ? $data['template'] : array();
		?>
		<p><a href="<?php echo esc_url( admin_url( 'admin.php?page=tbay-manage-email' ) ); ?>">
			&larr; <?php esc_html_e( 'Back to templates', 'tbay-rewards' ); ?></a></p>

		<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
			<?php wp_nonce_field( 'tbay_manage' ); ?>
			<input type="hidden" name="action" value="tbay_manage" />
			<input type="hidden" name="tbay_action" value="save_template" />
			<input type="hidden" name="tbay_screen" value="email" />
			<input type="hidden" name="key" value="<?php echo esc_attr( $key ); ?>" />

			<table class="form-table" role="presentation">
				<tr>
					<th scope="row"><label for="tbay-subject"><?php esc_html_e( 'Subject', 'tbay-rewards' ); ?></label></th>
					<td><input type="text" id="tbay-subject" name="subject" class="large-text"
						value="<?php echo esc_attr( (string) ( $template['subject'] ?? '' ) ); ?>" required /></td>
				</tr>
				<tr>
					<th scope="row"><label for="tbay-html"><?php esc_html_e( 'HTML', 'tbay-rewards' ); ?></label></th>
					<td>
						<textarea id="tbay-html" name="html" rows="20" class="large-text code" required><?php
							echo esc_textarea( (string) ( $template['html'] ?? '' ) );
						?></textarea>
						<p class="description">
							<?php esc_html_e( 'Placeholders like {{name}}, {{tenant_name}} and {{unsubscribe_url}} are filled in when the email is sent, and are escaped so they cannot break the layout.', 'tbay-rewards' ); ?>
						</p>
					</td>
				</tr>
				<tr>
					<th scope="row"><?php esc_html_e( 'Kind', 'tbay-rewards' ); ?></th>
					<td>
						<label>
							<input type="checkbox" name="transactional" value="1"
								<?php checked( (bool) ( $template['transactional'] ?? false ) ); ?> />
							<?php esc_html_e( 'Transactional — send even to people who have not opted into marketing', 'tbay-rewards' ); ?>
						</label>
						<p class="description">
							<?php esc_html_e( 'A receipt for something the customer just did is transactional. Anything they did not ask for is marketing and needs consent. If you are unsure, leave this off and ask whoever handles your privacy policy.', 'tbay-rewards' ); ?>
						</p>
					</td>
				</tr>
			</table>
			<?php submit_button( __( 'Save template', 'tbay-rewards' ) ); ?>
		</form>
		<?php
	}

	private function do_save_template(): string|WP_Error {
		$html = isset( $_POST['html'] ) ? wp_kses_post( wp_unslash( $_POST['html'] ) ) : '';
		if ( '' === $html ) {
			return new WP_Error( 'tbay_bad_input', __( 'An email needs a body.', 'tbay-rewards' ) );
		}

		$result = $this->api->request(
			'PUT',
			'/v1/email/templates/' . rawurlencode( $this->post( 'key' ) ),
			array(
				'subject'       => $this->post( 'subject' ),
				'html'          => $html,
				'transactional' => isset( $_POST['transactional'] ),
			)
		);
		return is_wp_error( $result ) ? $result : __( 'Template saved.', 'tbay-rewards' );
	}

	private function do_suppress_email(): string|WP_Error {
		$result = $this->api->post(
			'/v1/email/suppressions',
			array( 'email' => $this->post( 'email' ), 'reason' => 'manual', 'detail' => 'Added from wp-admin' )
		);
		return is_wp_error( $result ) ? $result : __( 'That address will not be emailed.', 'tbay-rewards' );
	}

	private function do_unsuppress_email(): string|WP_Error {
		$result = $this->api->request(
			'DELETE',
			'/v1/email/suppressions/' . rawurlencode( $this->post( 'email' ) )
		);
		return is_wp_error( $result ) ? $result : __( 'That address can be emailed again.', 'tbay-rewards' );
	}
}
