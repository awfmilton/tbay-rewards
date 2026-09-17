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

	/**
	 * The template or broadcast the builder is editing.
	 *
	 * Fetched once and kept, because `admin_enqueue_scripts` runs before the
	 * screen renders: the enqueue needs the blocks to hand to JavaScript and
	 * the screen needs the same record to fill in its fields, and fetching it
	 * twice would mean two API round trips for one page.
	 *
	 * `false` distinguishes "looked and there is none" from "not looked yet".
	 */
	private array|false|null $builder_record = null;

	/** Screens, in menu order. */
	private const SCREENS = array(
		'customers'    => 'Customers',
		'ledger'       => 'Points ledger',
		'rules'        => 'Earning rules',
		'gamification' => 'Badges & ranks',
		'marketing'    => 'Segments & sends',
		'email'        => 'Email',
		'currencies'   => 'Currencies',
		'privacy'      => 'Privacy',
		'access'       => 'Access & audit',
		'reports'      => 'Reports',
	);

	public function __construct( private TBAY_Rewards_API $api ) {
		add_action( 'admin_menu', array( $this, 'add_pages' ), 20 );
		add_action( 'admin_post_tbay_manage', array( $this, 'handle_post' ) );
		add_action( 'admin_enqueue_scripts', array( $this, 'enqueue' ) );
		add_action( 'wp_ajax_tbay_email_preview', array( $this, 'ajax_preview' ) );
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

		if ( $this->builder_wanted() ) {
			$this->enqueue_builder();
		}
	}

	/**
	 * Is this request one of the two screens that compose a message?
	 *
	 * Checked rather than loading the builder on every management screen: it
	 * fetches the block catalogue from the API, and a ledger page should not
	 * pay for a request it will never use.
	 */
	private function builder_wanted(): bool {
		$screen = $this->current_screen();
		if ( 'marketing' === $screen ) {
			return true;
		}
		return 'email' === $screen && '' !== $this->query( 'template' );
	}

	/**
	 * The record being edited: a template, or a broadcast.
	 *
	 * Returns an empty array for a new one, which is the right starting state
	 * for both the builder and the form around it.
	 */
	private function builder_record(): array {
		if ( null !== $this->builder_record ) {
			return $this->builder_record ?: array();
		}

		$screen = $this->current_screen();
		$path   = '';
		$field  = '';
		if ( 'email' === $screen && '' !== $this->query( 'template' ) ) {
			$path  = '/v1/email/templates/' . rawurlencode( $this->query( 'template' ) );
			$field = 'template';
		} elseif ( 'marketing' === $screen && '' !== $this->query( 'broadcast' ) ) {
			$path  = '/v1/broadcasts/' . rawurlencode( $this->query( 'broadcast' ) );
			$field = 'broadcast';
		}

		if ( '' === $path ) {
			$this->builder_record = false;
			return array();
		}

		$data = $this->api->request( 'GET', $path );
		$this->builder_record = ( ! is_wp_error( $data ) && is_array( $data[ $field ] ?? null ) )
			? $data[ $field ]
			: false;
		return $this->builder_record ?: array();
	}

	/** The blocks that record holds, if it was composed rather than written. */
	private function builder_blocks(): array {
		$blocks = $this->builder_record()['blocks'] ?? null;
		return is_array( $blocks ) ? $blocks : array();
	}

	private function enqueue_builder(): void {
		wp_enqueue_script(
			'tbay-email-builder',
			TBAY_REWARDS_URL . 'assets/tbay-email-builder.js',
			array(),
			TBAY_REWARDS_VERSION,
			true
		);

		$catalogue = $this->api->request( 'GET', '/v1/email/blocks' );
		$catalogue = is_wp_error( $catalogue ) ? array() : ( $catalogue['blocks'] ?? array() );

		wp_localize_script(
			'tbay-email-builder',
			'tbayBuilder',
			array(
				'catalogue' => $catalogue,
				'value'     => $this->builder_blocks(),
				'preview'   => array(
					'url'    => admin_url( 'admin-ajax.php' ),
					'action' => 'tbay_email_preview',
					'nonce'  => wp_create_nonce( 'tbay_email_preview' ),
				),
				'strings'   => array(
					'addBlock'      => __( 'Add a block', 'tbay-rewards' ),
					'addRow'        => __( 'Add another', 'tbay-rewards' ),
					'conditional'   => __( 'Conditional blocks in this message:', 'tbay-rewards' ),
					'empty'         => __( 'No blocks yet. Add one below.', 'tbay-rewards' ),
					'loading'       => __( 'Rendering…', 'tbay-rewards' ),
					'matching'      => __( 'this person is in:', 'tbay-rewards' ),
					'moveDown'      => __( 'Move down', 'tbay-rewards' ),
					'moveUp'        => __( 'Move up', 'tbay-rewards' ),
					'none'          => __( 'none', 'tbay-rewards' ),
					'preview'       => __( 'Preview', 'tbay-rewards' ),
					'previewFailed' => __( 'That preview could not be rendered.', 'tbay-rewards' ),
					'removeBlock'   => __( 'Remove', 'tbay-rewards' ),
					'removeRow'     => __( 'Remove', 'tbay-rewards' ),
				),
			)
		);
	}

	/**
	 * What the composed message will look like, without saving or sending it.
	 *
	 * Proxied through wp-admin rather than called from the browser, because the
	 * API key lives on the server. Shipping it to the page so JavaScript could
	 * call the API directly would hand every logged-in author a key that can
	 * read the whole contact list.
	 */
	public function ajax_preview(): void {
		if ( ! current_user_can( self::CAPABILITY ) ) {
			wp_send_json_error( array( 'message' => __( 'You do not have permission to do that.', 'tbay-rewards' ) ), 403 );
		}
		check_ajax_referer( 'tbay_email_preview' );

		$posted = isset( $_POST['blocks'] ) ? wp_unslash( $_POST['blocks'] ) : '[]';
		$blocks = is_string( $posted ) ? json_decode( $posted, true ) : null;
		if ( ! is_array( $blocks ) ) {
			wp_send_json_error( array( 'message' => __( 'Those blocks could not be read.', 'tbay-rewards' ) ), 400 );
		}

		$payload = array( 'blocks' => $blocks );
		foreach ( array( 'subject', 'preheader', 'as' ) as $field ) {
			$value = isset( $_POST[ $field ] ) ? sanitize_text_field( wp_unslash( $_POST[ $field ] ) ) : '';
			if ( '' !== $value ) {
				$payload[ $field ] = $value;
			}
		}

		$result = $this->api->post( '/v1/email/preview', $payload );
		if ( is_wp_error( $result ) ) {
			wp_send_json_error( array( 'message' => $result->get_error_message() ), 400 );
		}
		wp_send_json_success( $result );
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
			case 'currencies':
				$this->screen_currencies();
				break;
			case 'privacy':
				$this->screen_privacy();
				break;
			case 'access':
				$this->screen_access();
				break;
			case 'reports':
				$this->screen_reports();
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
	/** Where a one-shot notice waits between the POST and the redirect. */
	private function notice_key(): string {
		return 'tbay_notice_' . get_current_user_id();
	}

	/**
	 * Show what the last action said, once.
	 *
	 * Carried in a transient rather than the URL. A message read out of a query
	 * string is a message anybody can write: a link to
	 * `…&tbay_msg=Your+key+was+compromised,+email+it+to+support` shows an admin
	 * whatever the sender chose, in the site's own voice. It was escaped, so
	 * never a scripting hole — but "the admin screen said so" is most of what a
	 * convincing pretext needs.
	 */
	private function render_notice(): void {
		$notice = get_transient( $this->notice_key() );
		if ( ! is_array( $notice ) || empty( $notice['message'] ) ) {
			return;
		}
		delete_transient( $this->notice_key() );

		printf(
			'<div class="notice notice-%s is-dismissible"><p>%s</p></div>',
			empty( $notice['error'] ) ? 'success' : 'error',
			esc_html( (string) $notice['message'] )
		);
	}

	private function redirect_back( string $screen, string $message, bool $error = false, array $extra = array() ): void {
		set_transient(
			$this->notice_key(),
			array( 'message' => $message, 'error' => $error ),
			MINUTE_IN_SECONDS
		);

		$url = add_query_arg(
			array_merge( array( 'page' => 'tbay-manage-' . $screen ), $extra ),
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
			'save_topic'       => $this->do_save_topic(),
			'delete_topic'     => $this->do_delete_topic(),
			'save_point_type'  => $this->do_save_point_type(),
			'save_field'       => $this->do_save_field(),
			'delete_field'     => $this->do_delete_field(),
			'save_field_values' => $this->do_save_field_values(),
			'merge_contacts'   => $this->do_merge_contacts(),
			'save_operator'    => $this->do_save_operator(),
			'delete_operator'  => $this->do_delete_operator(),
			'issue_key'        => $this->do_issue_key(),
			'revoke_key'       => $this->do_revoke_key(),
			'save_report'      => $this->do_save_report(),
			'delete_report'    => $this->do_delete_report(),
			'schedule_report'  => $this->do_schedule_report(),
			'send_report'      => $this->do_send_report(),
			'erase_contact'    => $this->do_erase_contact(),
			'export_contact'   => $this->do_export_contact(),
			'save_retention'   => $this->do_save_retention(),
			'delete_point_type' => $this->do_delete_point_type(),
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
		$this->render_field_values(
			(string) ( $contact['id'] ?? '' ),
			is_array( $data['fields'] ?? null ) ? $data['fields'] : array(),
			is_array( $data['field_values'] ?? null ) ? $data['field_values'] : array()
		);
		$this->render_merge_form( (string) ( $contact['id'] ?? '' ) );
		$this->render_privacy_actions( (string) ( $contact['id'] ?? '' ), $contact );
		$this->render_timeline( $timeline );
	}

	/**
	 * Answering a subject access request, and carrying out an erasure.
	 *
	 * Both belong on the customer screen rather than a settings page: they are
	 * things somebody does about one named person, usually while that person is
	 * on the phone.
	 *
	 * @param array<string,mixed> $contact The contact record.
	 */
	private function render_privacy_actions( string $contact_id, array $contact ): void {
		if ( '' === $contact_id ) {
			return;
		}

		if ( ! empty( $contact['erased_at'] ) ) {
			printf(
				'<div class="notice notice-info inline"><p>%s</p></div>',
				esc_html(
					sprintf(
						/* translators: %s: date the contact was erased. */
						__( 'This person was erased on %s. Their order and points history is kept; everything identifying them is gone.', 'tbay-rewards' ),
						mysql2date( get_option( 'date_format' ), (string) $contact['erased_at'] )
					)
				)
			);
			return;
		}
		?>
		<h3><?php esc_html_e( 'Privacy', 'tbay-rewards' ); ?></h3>
		<p class="description">
			<?php
			esc_html_e(
				'Erasing keeps the order and points history the store needs for its own accounts, and removes everything that identifies the person. It cannot be undone, and they cannot be added back afterwards.',
				'tbay-rewards'
			);
			?>
		</p>
		<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" class="tbay-row-form">
			<?php wp_nonce_field( 'tbay_manage' ); ?>
			<input type="hidden" name="action" value="tbay_manage" />
			<input type="hidden" name="tbay_action" value="export_contact" />
			<input type="hidden" name="tbay_screen" value="customers" />
			<input type="hidden" name="contact_id" value="<?php echo esc_attr( $contact_id ); ?>" />
			<?php submit_button( __( 'Download everything held', 'tbay-rewards' ), 'secondary', '', false ); ?>
		</form>
		<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" class="tbay-row-form"
			onsubmit="return confirm(<?php echo esc_attr( wp_json_encode( __( 'Erase this person permanently? Their history stays for your accounts, but they cannot be added back.', 'tbay-rewards' ) ) ); ?>);">
			<?php wp_nonce_field( 'tbay_manage' ); ?>
			<input type="hidden" name="action" value="tbay_manage" />
			<input type="hidden" name="tbay_action" value="erase_contact" />
			<input type="hidden" name="tbay_screen" value="customers" />
			<input type="hidden" name="contact_id" value="<?php echo esc_attr( $contact_id ); ?>" />
			<input type="text" name="requested_by" class="regular-text"
				placeholder="<?php esc_attr_e( 'Ticket or reference (optional)', 'tbay-rewards' ); ?>" />
			<label>
				<input type="checkbox" name="keep_points" value="1" />
				<?php esc_html_e( 'Keep their points balance (you are settling it separately)', 'tbay-rewards' ); ?>
			</label>
			<?php submit_button( __( 'Erase this person', 'tbay-rewards' ), 'delete', '', false ); ?>
		</form>
		<?php
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
					<th><?php esc_html_e( 'Currency', 'tbay-rewards' ); ?></th>
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
					<td><code><?php echo esc_html( (string) ( $rule['point_type'] ?? 'points' ) ); ?></code></td>
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
		if ( '' !== $this->query( 'broadcast' ) ) {
			$this->render_broadcast_composer( $this->query( 'broadcast' ) );
			return;
		}

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
							<a href="<?php echo esc_url( admin_url(
								'admin.php?page=tbay-manage-marketing&broadcast=' . rawurlencode( (string) ( $send['key'] ?? '' ) )
							) ); ?>"><?php esc_html_e( 'Write it', 'tbay-rewards' ); ?></a>
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
			<input type="text" name="subject" required placeholder="<?php esc_attr_e( 'Subject line', 'tbay-rewards' ); ?>"
				class="regular-text" aria-label="<?php esc_attr_e( 'Subject', 'tbay-rewards' ); ?>" />
			<input type="text" name="templateKey" placeholder="<?php esc_attr_e( 'Email template key (optional)', 'tbay-rewards' ); ?>"
				aria-label="<?php esc_attr_e( 'Template', 'tbay-rewards' ); ?>" />
			<?php submit_button( __( 'Save draft', 'tbay-rewards' ), 'secondary', '', false ); ?>
			<p class="description">
				<?php esc_html_e( 'Name a template to reuse one, or leave it blank and write the message here with "Write it".', 'tbay-rewards' ); ?>
			</p>
		</form>
		<?php
	}

	/**
	 * Write the message a send goes out with.
	 *
	 * A broadcast can name a template, or carry a body composed here. The
	 * monthly newsletter is a one-off, and making somebody create a template
	 * for each one is how a "send" screen grows a "template" screen nobody
	 * wanted — and a template list that is really a send history.
	 */
	private function render_broadcast_composer( string $key ): void {
		$send = $this->builder_record();
		if ( array() === $send ) {
			printf(
				'<div class="notice notice-error"><p>%s</p></div>',
				esc_html__( 'That send could not be loaded.', 'tbay-rewards' )
			);
			return;
		}

		$status = (string) ( $send['status'] ?? '' );
		$locked = ! in_array( $status, array( 'draft', 'scheduled' ), true );
		?>
		<p><a href="<?php echo esc_url( admin_url( 'admin.php?page=tbay-manage-marketing' ) ); ?>">
			&larr; <?php esc_html_e( 'Back to sends', 'tbay-rewards' ); ?></a></p>

		<h2><?php echo esc_html( (string) ( $send['name'] ?? $key ) ); ?></h2>

		<?php if ( $locked ) : ?>
			<div class="notice notice-info inline"><p>
				<?php
				printf(
					/* translators: %s: broadcast status, such as "sent" */
					esc_html__( 'This send is %s, so its message can no longer be edited. What went out is what the recipient list records.', 'tbay-rewards' ),
					esc_html( $status )
				);
				?>
			</p></div>
			<?php return; ?>
		<?php endif; ?>

		<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
			<?php wp_nonce_field( 'tbay_manage' ); ?>
			<input type="hidden" name="action" value="tbay_manage" />
			<input type="hidden" name="tbay_action" value="save_broadcast" />
			<input type="hidden" name="tbay_screen" value="marketing" />
			<input type="hidden" name="key" value="<?php echo esc_attr( $key ); ?>" />
			<input type="hidden" name="name" value="<?php echo esc_attr( (string) ( $send['name'] ?? $key ) ); ?>" />

			<table class="form-table" role="presentation">
				<tr>
					<th scope="row"><label for="tbay-subject"><?php esc_html_e( 'Subject', 'tbay-rewards' ); ?></label></th>
					<td><input type="text" id="tbay-subject" name="subject" class="large-text" required
						value="<?php echo esc_attr( (string) ( $send['subject'] ?? '' ) ); ?>" /></td>
				</tr>
				<tr>
					<th scope="row"><label for="tbay-preheader"><?php esc_html_e( 'Preview line', 'tbay-rewards' ); ?></label></th>
					<td>
						<input type="text" id="tbay-preheader" name="preheader" class="large-text" maxlength="200"
							value="<?php echo esc_attr( (string) ( $send['preheader'] ?? '' ) ); ?>" />
						<p class="description">
							<?php esc_html_e( 'The line shown after the subject in an inbox. Left blank, the mail client shows the first words of the message instead.', 'tbay-rewards' ); ?>
						</p>
					</td>
				</tr>
				<tr>
					<th scope="row"><?php esc_html_e( 'Message', 'tbay-rewards' ); ?></th>
					<td>
						<input type="hidden" id="tbay-blocks" name="blocks" value="" />
						<div id="tbay-builder" class="tbay-builder"></div>
						<p class="description">
							<?php esc_html_e( 'Saving a message here replaces the template this send named, if it named one.', 'tbay-rewards' ); ?>
						</p>
						<p>
							<label for="tbay-preview-as"><?php esc_html_e( 'Preview as contact ID', 'tbay-rewards' ); ?></label>
							<input type="text" id="tbay-preview-as" class="regular-text" />
							<span class="description">
								<?php esc_html_e( 'Optional. Naming somebody shows the blocks they would actually get.', 'tbay-rewards' ); ?>
							</span>
						</p>
						<div id="tbay-builder-preview" class="tbay-builder-preview"></div>
					</td>
				</tr>
			</table>
			<?php submit_button( __( 'Save message', 'tbay-rewards' ) ); ?>
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
		$payload = array( 'name' => $this->post( 'name' ) );

		// Only what this form actually carried: the composer posts a message
		// and no segment, the "prepare a send" form posts a segment and no
		// message, and sending an empty string for the other would clear it.
		foreach ( array( 'segmentKey', 'templateKey', 'subject', 'preheader' ) as $field ) {
			if ( isset( $_POST[ $field ] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Missing
				$payload[ $field ] = $this->post( $field );
			}
		}

		$blocks = $this->posted_blocks();
		if ( is_wp_error( $blocks ) ) {
			return $blocks;
		}
		if ( null !== $blocks ) {
			$payload['blocks'] = $blocks;
			// A composed body replaces the template, and sending both would
			// leave the server picking one.
			unset( $payload['templateKey'] );
		} elseif ( '' === ( $payload['templateKey'] ?? '' ) ) {
			// A draft with no template is one somebody means to write here.
			// Nothing is sent for the body: an empty list would look like a
			// composed message and wipe whatever "Write it" had put there —
			// and this form is the only screen that can change a segment, so
			// it is re-submitted for sends that already have a message.
			unset( $payload['templateKey'] );
		}

		$result = $this->api->request(
			'PUT',
			'/v1/broadcasts/' . rawurlencode( $this->post( 'key' ) ),
			$payload
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
		$this->render_topics();
	}

	private function render_template_editor( string $key ): void {
		$template = $this->builder_record();
		if ( array() === $template ) {
			printf(
				'<div class="notice notice-error"><p>%s</p></div>',
				esc_html__( 'That template could not be loaded.', 'tbay-rewards' )
			);
			return;
		}

		// A template that was composed reopens in the builder. One that was
		// hand-written reopens in the textarea it was written in — switching it
		// to blocks would mean parsing HTML back into blocks, which does not
		// work, so the choice is offered rather than made.
		$composed = array() !== $this->builder_blocks() || '1' === $this->query( 'build' );
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
					<th scope="row"><label for="tbay-preheader"><?php esc_html_e( 'Preview line', 'tbay-rewards' ); ?></label></th>
					<td>
						<input type="text" id="tbay-preheader" name="preheader" class="large-text" maxlength="200"
							value="<?php echo esc_attr( (string) ( $template['preheader'] ?? '' ) ); ?>" />
						<p class="description">
							<?php esc_html_e( 'The line shown after the subject in an inbox. Left blank, the mail client shows the first words of the message instead.', 'tbay-rewards' ); ?>
						</p>
					</td>
				</tr>
				<?php if ( $composed ) : ?>
				<tr>
					<th scope="row"><?php esc_html_e( 'Message', 'tbay-rewards' ); ?></th>
					<td>
						<input type="hidden" id="tbay-blocks" name="blocks" value="" />
						<div id="tbay-builder" class="tbay-builder"></div>
						<p class="description">
							<?php esc_html_e( 'Placeholders like {{name}}, {{tenant_name}} and {{points_balance}} are filled in when the email is sent, and are escaped so they cannot break the layout.', 'tbay-rewards' ); ?>
						</p>
						<p>
							<label for="tbay-preview-as"><?php esc_html_e( 'Preview as contact ID', 'tbay-rewards' ); ?></label>
							<input type="text" id="tbay-preview-as" class="regular-text" />
							<span class="description">
								<?php esc_html_e( 'Optional. Naming somebody shows the blocks they would actually get.', 'tbay-rewards' ); ?>
							</span>
						</p>
						<div id="tbay-builder-preview" class="tbay-builder-preview"></div>
					</td>
				</tr>
				<?php else : ?>
				<tr>
					<th scope="row"><label for="tbay-html"><?php esc_html_e( 'HTML', 'tbay-rewards' ); ?></label></th>
					<td>
						<textarea id="tbay-html" name="html" rows="20" class="large-text code" required><?php
							echo esc_textarea( (string) ( $template['html'] ?? '' ) );
						?></textarea>
						<p class="description">
							<?php esc_html_e( 'Placeholders like {{name}}, {{tenant_name}} and {{unsubscribe_url}} are filled in when the email is sent, and are escaped so they cannot break the layout.', 'tbay-rewards' ); ?>
						</p>
						<p class="description">
							<a href="<?php echo esc_url( add_query_arg( 'build', '1' ) ); ?>">
								<?php esc_html_e( 'Build this one from blocks instead', 'tbay-rewards' ); ?>
							</a>
							<?php esc_html_e( '— this replaces the HTML above, which cannot be turned back into blocks.', 'tbay-rewards' ); ?>
						</p>
					</td>
				</tr>
				<?php endif; ?>
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
		$payload = array(
			'subject'       => $this->post( 'subject' ),
			'preheader'     => $this->post( 'preheader' ),
			'transactional' => isset( $_POST['transactional'] ),
		);

		$blocks = $this->posted_blocks();
		if ( is_wp_error( $blocks ) ) {
			return $blocks;
		}

		if ( null !== $blocks ) {
			// The server renders the HTML from these. Nothing here composes
			// markup, which is why this path needs no `wp_kses_post`: there is
			// no markup to sanitise, only field values that are escaped when
			// they are rendered.
			$payload['blocks'] = $blocks;
		} else {
			// Not `wp_kses_post`. An email is a whole document — `<html>`,
			// `<head>`, `<style>` — none of which are allowed post tags, so
			// kses stripped the tags and left the CSS behind as visible text at
			// the top of every message. It was not buying anything either: this
			// form needs `manage_options`, which can already edit plugin files,
			// and the only place the HTML is rendered in wp-admin is the
			// sandboxed preview iframe.
			$posted = $_POST['html'] ?? ''; // phpcs:ignore WordPress.Security.ValidatedSanitizedInput
			$html   = is_string( $posted ) ? trim( wp_unslash( $posted ) ) : '';
			if ( '' === $html ) {
				return new WP_Error( 'tbay_bad_input', __( 'An email needs a body.', 'tbay-rewards' ) );
			}
			$payload['html'] = $html;
		}

		$result = $this->api->request(
			'PUT',
			'/v1/email/templates/' . rawurlencode( $this->post( 'key' ) ),
			$payload
		);
		return is_wp_error( $result ) ? $result : __( 'Template saved.', 'tbay-rewards' );
	}

	/**
	 * The blocks this form posted, if it was the builder that posted it.
	 *
	 * Returns null when the form carried no builder at all — a hand-written
	 * template — and an error when it carried one that cannot be read, rather
	 * than silently saving an empty message over somebody's newsletter.
	 */
	private function posted_blocks(): array|WP_Error|null {
		if ( ! isset( $_POST['blocks'] ) ) {
			return null;
		}

		$posted = wp_unslash( $_POST['blocks'] ); // phpcs:ignore WordPress.Security.ValidatedSanitizedInput
		if ( ! is_string( $posted ) ) {
			// `blocks[]=…` rather than the JSON the builder posts. Only an
			// admin can send it, and a TypeError is still the wrong answer.
			return new WP_Error( 'tbay_bad_input', __( 'That message could not be read. Nothing was saved.', 'tbay-rewards' ) );
		}

		$raw = trim( $posted );
		if ( '' === $raw ) {
			return null;
		}

		$blocks = json_decode( $raw, true );
		if ( ! is_array( $blocks ) ) {
			return new WP_Error( 'tbay_bad_input', __( 'That message could not be read. Nothing was saved.', 'tbay-rewards' ) );
		}
		if ( array() === $blocks ) {
			return new WP_Error( 'tbay_bad_input', __( 'An email needs a body. Add at least one block.', 'tbay-rewards' ) );
		}
		return $blocks;
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

	// ── Currencies ───────────────────────────────────────────────────────────

	/**
	 * More than one currency, side by side.
	 *
	 * "Points" you spend and "status credits" you only accumulate is the
	 * classic pair, and the second only means anything if it genuinely cannot
	 * be spent — which is what the two checkboxes here decide. A store that
	 * never adds a second currency sees one row and can ignore this screen.
	 */
	private function screen_currencies(): void {
		$result = $this->api->request( 'GET', '/v1/point-types' );
		$types  = is_wp_error( $result ) ? array() : ( $result['point_types'] ?? array() );

		echo '<h2>' . esc_html__( 'What customers earn', 'tbay-rewards' ) . '</h2>';
		?>
		<table class="widefat striped">
			<thead>
				<tr>
					<th><?php esc_html_e( 'Currency', 'tbay-rewards' ); ?></th>
					<th><?php esc_html_e( 'Default', 'tbay-rewards' ); ?></th>
					<th><?php esc_html_e( 'Cashable', 'tbay-rewards' ); ?></th>
					<th><?php esc_html_e( 'Sendable', 'tbay-rewards' ); ?></th>
					<th></th>
				</tr>
			</thead>
			<tbody>
			<?php foreach ( $types as $type ) : ?>
				<?php $key = (string) ( $type['key'] ?? '' ); ?>
				<tr>
					<td>
						<strong><?php echo esc_html( (string) ( $type['name'] ?? $key ) ); ?></strong><br />
						<code><?php echo esc_html( $key ); ?></code>
					</td>
					<td><?php echo ( $type['is_default'] ?? false ) ? esc_html__( 'Yes', 'tbay-rewards' ) : '—'; ?></td>
					<td><?php echo ( $type['convertible'] ?? false ) ? esc_html__( 'Yes', 'tbay-rewards' ) : '—'; ?></td>
					<td><?php echo ( $type['transferable'] ?? false ) ? esc_html__( 'Yes', 'tbay-rewards' ) : '—'; ?></td>
					<td>
						<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" class="tbay-row-form">
							<?php wp_nonce_field( 'tbay_manage' ); ?>
							<input type="hidden" name="action" value="tbay_manage" />
							<input type="hidden" name="tbay_action" value="save_point_type" />
							<input type="hidden" name="tbay_screen" value="currencies" />
							<input type="hidden" name="key" value="<?php echo esc_attr( $key ); ?>" />
							<label>
								<input type="checkbox" name="convertible" value="1" <?php checked( (bool) ( $type['convertible'] ?? false ) ); ?> />
								<?php esc_html_e( 'Cashable', 'tbay-rewards' ); ?>
							</label>
							<label>
								<input type="checkbox" name="transferable" value="1" <?php checked( (bool) ( $type['transferable'] ?? false ) ); ?> />
								<?php esc_html_e( 'Sendable', 'tbay-rewards' ); ?>
							</label>
							<?php submit_button( __( 'Save', 'tbay-rewards' ), 'small', '', false ); ?>
						</form>
					</td>
				</tr>
			<?php endforeach; ?>
			</tbody>
		</table>

		<h3><?php esc_html_e( 'Add a currency', 'tbay-rewards' ); ?></h3>
		<p class="description">
			<?php
			esc_html_e(
				'Leave both boxes unticked for a status currency: one members accumulate but can never cash out or hand to each other. That restriction is what makes it mean something.',
				'tbay-rewards'
			);
			?>
		</p>
		<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
			<?php wp_nonce_field( 'tbay_manage' ); ?>
			<input type="hidden" name="action" value="tbay_manage" />
			<input type="hidden" name="tbay_action" value="save_point_type" />
			<input type="hidden" name="tbay_screen" value="currencies" />
			<table class="form-table">
				<tr>
					<th scope="row"><label for="tbay-pt-key"><?php esc_html_e( 'Key', 'tbay-rewards' ); ?></label></th>
					<td>
						<input type="text" id="tbay-pt-key" name="key" class="regular-text"
							pattern="[a-z0-9_]{2,32}" required />
						<p class="description"><?php esc_html_e( '2-32 characters of a-z, 0-9 or underscore. It cannot be changed later.', 'tbay-rewards' ); ?></p>
					</td>
				</tr>
				<tr>
					<th scope="row"><label for="tbay-pt-name"><?php esc_html_e( 'Name', 'tbay-rewards' ); ?></label></th>
					<td><input type="text" id="tbay-pt-name" name="name" class="regular-text" /></td>
				</tr>
				<tr>
					<th scope="row"><?php esc_html_e( 'Wording', 'tbay-rewards' ); ?></th>
					<td>
						<input type="text" name="singular" placeholder="<?php esc_attr_e( 'status credit', 'tbay-rewards' ); ?>" />
						<input type="text" name="plural" placeholder="<?php esc_attr_e( 'status credits', 'tbay-rewards' ); ?>" />
					</td>
				</tr>
				<tr>
					<th scope="row"><?php esc_html_e( 'Rules', 'tbay-rewards' ); ?></th>
					<td>
						<label><input type="checkbox" name="convertible" value="1" /> <?php esc_html_e( 'Can be exchanged for store credit or TBAY', 'tbay-rewards' ); ?></label><br />
						<label><input type="checkbox" name="transferable" value="1" /> <?php esc_html_e( 'Can be sent to another member', 'tbay-rewards' ); ?></label>
					</td>
				</tr>
			</table>
			<?php submit_button( __( 'Add currency', 'tbay-rewards' ) ); ?>
		</form>
		<?php
	}

	private function do_save_point_type(): string|WP_Error {
		$key = $this->post( 'key' );
		if ( ! preg_match( '/^[a-z0-9_]{2,32}$/', $key ) ) {
			return new WP_Error(
				'tbay_bad_input',
				__( 'A currency key is 2-32 characters of a-z, 0-9 or underscore.', 'tbay-rewards' )
			);
		}

		$payload = array(
			'convertible'  => isset( $_POST['convertible'] ),
			'transferable' => isset( $_POST['transferable'] ),
		);

		// Only sent when filled in, so the inline row form — which has no name
		// or wording fields — does not blank them on the way past.
		foreach ( array( 'name', 'singular', 'plural' ) as $field ) {
			$value = $this->post( $field );
			if ( '' !== $value ) {
				$payload[ $field ] = $value;
			}
		}

		$result = $this->api->request( 'PUT', '/v1/point-types/' . rawurlencode( $key ), $payload );
		return is_wp_error( $result ) ? $result : __( 'Currency saved.', 'tbay-rewards' );
	}

	private function do_delete_point_type(): string|WP_Error {
		$key = $this->post( 'key' );
		if ( '' === $key ) {
			return new WP_Error( 'tbay_bad_input', __( 'Which currency?', 'tbay-rewards' ) );
		}
		$result = $this->api->request( 'DELETE', '/v1/point-types/' . rawurlencode( $key ) );
		return is_wp_error( $result ) ? $result : __( 'Currency removed.', 'tbay-rewards' );
	}


	// ── Privacy ──────────────────────────────────────────────────────────────

	private function do_erase_contact(): string|WP_Error {
		$contact_id = $this->post( 'contact_id' );
		if ( '' === $contact_id ) {
			return new WP_Error( 'tbay_bad_input', __( 'Which person?', 'tbay-rewards' ) );
		}

		$result = $this->api->post(
			'/v1/privacy/erase',
			array(
				'contactId'   => $contact_id,
				'reason'      => 'request',
				'requestedBy' => $this->post( 'requested_by' ) ?: wp_get_current_user()->user_login,
				// The checkbox reads "keep their balance", so its absence is
				// the forfeit. Named the other way round in the API because
				// there the default is what happens, not what is ticked.
				'forfeitPoints' => ! isset( $_POST['keep_points'] ),
			)
		);
		if ( is_wp_error( $result ) ) {
			return $result;
		}

		return sprintf(
			/* translators: %s: number of points forfeited. */
			__( 'Erased. %s points were forfeited.', 'tbay-rewards' ),
			number_format_i18n( (int) ( $result['points_forfeited'] ?? 0 ) )
		);
	}

	/**
	 * Send the whole record to the browser as a file.
	 *
	 * Streamed straight out rather than stored anywhere: a subject access
	 * export is the most concentrated personal data the store will ever
	 * produce, and leaving copies of it in uploads/ is its own breach.
	 */
	private function do_export_contact(): string|WP_Error {
		$contact_id = $this->post( 'contact_id' );
		if ( '' === $contact_id ) {
			return new WP_Error( 'tbay_bad_input', __( 'Which person?', 'tbay-rewards' ) );
		}

		$data = $this->api->request( 'GET', '/v1/privacy/export', array(), array( 'contactId' => $contact_id ) );
		if ( is_wp_error( $data ) ) {
			return $data;
		}

		nocache_headers();
		header( 'Content-Type: application/json; charset=utf-8' );
		header(
			'Content-Disposition: attachment; filename="contact-' . sanitize_file_name( $contact_id ) . '.json"'
		);
		echo wp_json_encode( $data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES );
		exit;
	}

	private function do_save_retention(): string|WP_Error {
		// An empty field means "keep it forever", which is null rather than
		// zero — a zero-day window would delete everything on the next sweep.
		$window = function ( string $key ): ?int {
			$raw = $this->post( $key );
			if ( '' === trim( $raw ) ) {
				return null;
			}
			$value = (int) $raw;
			return $value > 0 ? $value : null;
		};

		$result = $this->api->request(
			'PUT',
			'/v1/privacy/retention',
			array(
				'eventDays'        => $window( 'event_days' ),
				'sessionDays'      => $window( 'session_days' ),
				'emailBodyDays'    => $window( 'email_body_days' ),
				'notificationDays' => $window( 'notification_days' ),
			)
		);
		return is_wp_error( $result ) ? $result : __( 'Retention saved.', 'tbay-rewards' );
	}


	// ── Privacy screen ───────────────────────────────────────────────────────

	/**
	 * Retention windows, and the record that erasures happened.
	 *
	 * Erasing one person is done from their own page, where the operator can
	 * see who they are erasing. This screen is the standing policy and the
	 * evidence — the two things somebody asks for at audit rather than at the
	 * counter.
	 */
	private function screen_privacy(): void {
		$this->render_field_definitions();

		$policy = $this->api->request( 'GET', '/v1/privacy/retention' );
		$policy = is_wp_error( $policy ) ? array() : ( $policy['retention'] ?? array() );

		$log = $this->api->request( 'GET', '/v1/privacy/erasures', array(), array( 'limit' => 50 ) );
		$log = is_wp_error( $log ) ? array() : ( $log['erasures'] ?? array() );

		$windows = array(
			'event_days'        => __( 'Page views and events', 'tbay-rewards' ),
			'session_days'      => __( 'Visits', 'tbay-rewards' ),
			'email_body_days'   => __( 'Email bodies', 'tbay-rewards' ),
			'notification_days' => __( 'In-store notifications', 'tbay-rewards' ),
		);
		?>
		<h2><?php esc_html_e( 'How long data is kept', 'tbay-rewards' ); ?></h2>
		<p class="description">
			<?php
			esc_html_e(
				'Leave a field empty to keep that data indefinitely, which is what happens today. Orders, points and commissions are never swept: they are your own records. Clearing an email body keeps whether it was delivered, opened and clicked.',
				'tbay-rewards'
			);
			?>
		</p>
		<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
			<?php wp_nonce_field( 'tbay_manage' ); ?>
			<input type="hidden" name="action" value="tbay_manage" />
			<input type="hidden" name="tbay_action" value="save_retention" />
			<input type="hidden" name="tbay_screen" value="privacy" />
			<table class="form-table">
				<?php foreach ( $windows as $key => $label ) : ?>
					<tr>
						<th scope="row">
							<label for="tbay-<?php echo esc_attr( $key ); ?>"><?php echo esc_html( $label ); ?></label>
						</th>
						<td>
							<input type="number" min="1" max="3650" class="small-text"
								id="tbay-<?php echo esc_attr( $key ); ?>"
								name="<?php echo esc_attr( $key ); ?>"
								value="<?php echo esc_attr( (string) ( $policy[ $key ] ?? '' ) ); ?>" />
							<?php esc_html_e( 'days', 'tbay-rewards' ); ?>
						</td>
					</tr>
				<?php endforeach; ?>
			</table>
			<?php submit_button( __( 'Save retention', 'tbay-rewards' ) ); ?>
		</form>

		<h2><?php esc_html_e( 'Erasures carried out', 'tbay-rewards' ); ?></h2>
		<p class="description">
			<?php
			esc_html_e(
				'Proof that a request was honoured. It holds no personal data — an erasure that recorded who it erased would defeat itself.',
				'tbay-rewards'
			);
			?>
		</p>
		<?php if ( empty( $log ) ) : ?>
			<p><?php esc_html_e( 'Nobody has been erased yet.', 'tbay-rewards' ); ?></p>
		<?php else : ?>
			<table class="widefat striped">
				<thead>
					<tr>
						<th><?php esc_html_e( 'When', 'tbay-rewards' ); ?></th>
						<th><?php esc_html_e( 'Why', 'tbay-rewards' ); ?></th>
						<th><?php esc_html_e( 'Reference', 'tbay-rewards' ); ?></th>
						<th><?php esc_html_e( 'Points forfeited', 'tbay-rewards' ); ?></th>
					</tr>
				</thead>
				<tbody>
				<?php foreach ( $log as $entry ) : ?>
					<tr>
						<td><?php echo esc_html( mysql2date( get_option( 'date_format' ) . ' H:i', (string) ( $entry['erased_at'] ?? '' ) ) ); ?></td>
						<td><?php echo esc_html( (string) ( $entry['reason'] ?? '' ) ); ?></td>
						<td><?php echo esc_html( (string) ( $entry['requested_by'] ?? '—' ) ); ?></td>
						<td><?php echo esc_html( number_format_i18n( (int) ( $entry['points_forfeited'] ?? 0 ) ) ); ?></td>
					</tr>
				<?php endforeach; ?>
				</tbody>
			</table>
		<?php endif; ?>
		<?php
	}


	// ── Email topics ─────────────────────────────────────────────────────────

	/**
	 * What a recipient can choose between on the preference page.
	 *
	 * A store that defines none keeps exactly today's behaviour: the page then
	 * offers only "pause" and "leave", which is still more than the binary
	 * choice an unsubscribe link gives.
	 */
	private function render_topics(): void {
		$result = $this->api->request( 'GET', '/v1/email/topics' );
		$topics = is_wp_error( $result ) ? array() : ( $result['topics'] ?? array() );

		$report = $this->api->request( 'GET', '/v1/email/preferences/report', array(), array( 'days' => 30 ) );
		$changes = is_wp_error( $report ) ? array() : ( $report['changes'] ?? array() );
		$counts = array();
		foreach ( $changes as $row ) {
			$counts[ (string) ( $row['action'] ?? '' ) ] = (int) ( $row['n'] ?? 0 );
		}
		?>
		<h2><?php esc_html_e( 'What customers can choose', 'tbay-rewards' ); ?></h2>
		<p class="description">
			<?php
			esc_html_e(
				'Topics appear on the preference page your emails link to. Somebody who would have unsubscribed can turn off one thing instead — which is the whole point of having the page.',
				'tbay-rewards'
			);
			?>
		</p>

		<?php if ( ! empty( $counts ) ) : ?>
			<p>
				<?php
				printf(
					/* translators: 1: number of topic changes, 2: pauses, 3: unsubscribes. */
					esc_html__( 'Last 30 days: %1$s changed a topic, %2$s paused, %3$s left.', 'tbay-rewards' ),
					esc_html( number_format_i18n( $counts['topics'] ?? 0 ) ),
					esc_html( number_format_i18n( $counts['paused'] ?? 0 ) ),
					esc_html( number_format_i18n( $counts['unsubscribed'] ?? 0 ) )
				);
				?>
			</p>
		<?php endif; ?>

		<table class="widefat striped">
			<thead>
				<tr>
					<th><?php esc_html_e( 'Topic', 'tbay-rewards' ); ?></th>
					<th><?php esc_html_e( 'On by default', 'tbay-rewards' ); ?></th>
					<th></th>
				</tr>
			</thead>
			<tbody>
			<?php foreach ( $topics as $topic ) : ?>
				<tr>
					<td>
						<strong><?php echo esc_html( (string) ( $topic['name'] ?? '' ) ); ?></strong><br />
						<code><?php echo esc_html( (string) ( $topic['key'] ?? '' ) ); ?></code>
						<?php if ( ! empty( $topic['description'] ) ) : ?>
							<p class="description"><?php echo esc_html( (string) $topic['description'] ); ?></p>
						<?php endif; ?>
					</td>
					<td><?php echo ( $topic['default_on'] ?? false ) ? esc_html__( 'Yes', 'tbay-rewards' ) : '—'; ?></td>
					<td>
						<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" class="tbay-row-form"
							onsubmit="return confirm(<?php echo esc_attr( wp_json_encode( __( 'Remove this topic? Everyone who chose about it loses that choice.', 'tbay-rewards' ) ) ); ?>);">
							<?php wp_nonce_field( 'tbay_manage' ); ?>
							<input type="hidden" name="action" value="tbay_manage" />
							<input type="hidden" name="tbay_action" value="delete_topic" />
							<input type="hidden" name="tbay_screen" value="email" />
							<input type="hidden" name="key" value="<?php echo esc_attr( (string) ( $topic['key'] ?? '' ) ); ?>" />
							<?php submit_button( __( 'Remove', 'tbay-rewards' ), 'small', '', false ); ?>
						</form>
					</td>
				</tr>
			<?php endforeach; ?>
			</tbody>
		</table>

		<h3><?php esc_html_e( 'Add a topic', 'tbay-rewards' ); ?></h3>
		<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
			<?php wp_nonce_field( 'tbay_manage' ); ?>
			<input type="hidden" name="action" value="tbay_manage" />
			<input type="hidden" name="tbay_action" value="save_topic" />
			<input type="hidden" name="tbay_screen" value="email" />
			<table class="form-table">
				<tr>
					<th scope="row"><label for="tbay-topic-key"><?php esc_html_e( 'Key', 'tbay-rewards' ); ?></label></th>
					<td>
						<input type="text" id="tbay-topic-key" name="key" class="regular-text"
							pattern="[a-z0-9_]{2,40}" required />
						<p class="description"><?php esc_html_e( 'Used on templates and broadcasts to say which topic they belong to.', 'tbay-rewards' ); ?></p>
					</td>
				</tr>
				<tr>
					<th scope="row"><label for="tbay-topic-name"><?php esc_html_e( 'Name', 'tbay-rewards' ); ?></label></th>
					<td><input type="text" id="tbay-topic-name" name="name" class="regular-text" /></td>
				</tr>
				<tr>
					<th scope="row"><label for="tbay-topic-desc"><?php esc_html_e( 'Description', 'tbay-rewards' ); ?></label></th>
					<td>
						<input type="text" id="tbay-topic-desc" name="description" class="large-text" />
						<p class="description"><?php esc_html_e( 'Shown under the name on the preference page.', 'tbay-rewards' ); ?></p>
					</td>
				</tr>
				<tr>
					<th scope="row"><?php esc_html_e( 'Default', 'tbay-rewards' ); ?></th>
					<td>
						<label>
							<input type="checkbox" name="default_on" value="1" checked />
							<?php esc_html_e( 'Send to people who have not expressed a view', 'tbay-rewards' ); ?>
						</label>
					</td>
				</tr>
			</table>
			<?php submit_button( __( 'Add topic', 'tbay-rewards' ) ); ?>
		</form>
		<?php
	}

	private function do_save_topic(): string|WP_Error {
		$key = $this->post( 'key' );
		if ( ! preg_match( '/^[a-z0-9_]{2,40}$/', $key ) ) {
			return new WP_Error(
				'tbay_bad_input',
				__( 'A topic key is 2-40 characters of a-z, 0-9 or underscore.', 'tbay-rewards' )
			);
		}

		$payload = array( 'defaultOn' => isset( $_POST['default_on'] ) );
		foreach ( array( 'name', 'description' ) as $field ) {
			$value = $this->post( $field );
			if ( '' !== $value ) {
				$payload[ $field ] = $value;
			}
		}

		$result = $this->api->request( 'PUT', '/v1/email/topics/' . rawurlencode( $key ), $payload );
		return is_wp_error( $result ) ? $result : __( 'Topic saved.', 'tbay-rewards' );
	}

	private function do_delete_topic(): string|WP_Error {
		$key = $this->post( 'key' );
		if ( '' === $key ) {
			return new WP_Error( 'tbay_bad_input', __( 'Which topic?', 'tbay-rewards' ) );
		}
		$result = $this->api->request( 'DELETE', '/v1/email/topics/' . rawurlencode( $key ) );
		return is_wp_error( $result ) ? $result : __( 'Topic removed.', 'tbay-rewards' );
	}


	// ── The retailer's own contact fields ────────────────────────────────────

	/**
	 * Values for one customer, rendered as the right control per type.
	 *
	 * A date field gets a date picker and a list field gets a dropdown, which
	 * is the point of declaring the type: a free-text box is how "ON", "on" and
	 * "Ontario" become three segments.
	 *
	 * @param array<int,array<string,mixed>> $fields Field definitions.
	 * @param array<string,mixed>            $values Current values by key.
	 */
	private function render_field_values( string $contact_id, array $fields, array $values ): void {
		if ( '' === $contact_id || empty( $fields ) ) {
			return;
		}
		?>
		<h3><?php esc_html_e( 'Your own fields', 'tbay-rewards' ); ?></h3>
		<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
			<?php wp_nonce_field( 'tbay_manage' ); ?>
			<input type="hidden" name="action" value="tbay_manage" />
			<input type="hidden" name="tbay_action" value="save_field_values" />
			<input type="hidden" name="tbay_screen" value="customers" />
			<input type="hidden" name="contact_id" value="<?php echo esc_attr( $contact_id ); ?>" />
			<table class="form-table">
				<?php foreach ( $fields as $field ) : ?>
					<?php
					$key   = (string) ( $field['key'] ?? '' );
					$kind  = (string) ( $field['kind'] ?? 'text' );
					$value = $values[ $key ] ?? null;
					$id    = 'tbay-cf-' . sanitize_key( $key );
					?>
					<tr>
						<th scope="row">
							<label for="<?php echo esc_attr( $id ); ?>">
								<?php echo esc_html( (string) ( $field['label'] ?? $key ) ); ?>
							</label>
						</th>
						<td>
							<?php if ( 'select' === $kind ) : ?>
								<select id="<?php echo esc_attr( $id ); ?>" name="cf[<?php echo esc_attr( $key ); ?>]">
									<option value=""><?php esc_html_e( '— not set —', 'tbay-rewards' ); ?></option>
									<?php foreach ( (array) ( $field['options'] ?? array() ) as $option ) : ?>
										<option value="<?php echo esc_attr( (string) $option ); ?>"
											<?php selected( (string) $value, (string) $option ); ?>>
											<?php echo esc_html( (string) $option ); ?>
										</option>
									<?php endforeach; ?>
								</select>
							<?php elseif ( 'boolean' === $kind ) : ?>
								<select id="<?php echo esc_attr( $id ); ?>" name="cf[<?php echo esc_attr( $key ); ?>]">
									<option value=""><?php esc_html_e( '— not answered —', 'tbay-rewards' ); ?></option>
									<option value="yes" <?php selected( true, true === $value ); ?>><?php esc_html_e( 'Yes', 'tbay-rewards' ); ?></option>
									<option value="no" <?php selected( true, false === $value ); ?>><?php esc_html_e( 'No', 'tbay-rewards' ); ?></option>
								</select>
							<?php elseif ( 'date' === $kind ) : ?>
								<input type="date" id="<?php echo esc_attr( $id ); ?>"
									name="cf[<?php echo esc_attr( $key ); ?>]"
									value="<?php echo esc_attr( $value ? substr( (string) $value, 0, 10 ) : '' ); ?>" />
							<?php elseif ( 'number' === $kind ) : ?>
								<input type="number" step="any" id="<?php echo esc_attr( $id ); ?>"
									name="cf[<?php echo esc_attr( $key ); ?>]"
									value="<?php echo esc_attr( null === $value ? '' : (string) $value ); ?>" />
							<?php else : ?>
								<input type="text" class="regular-text" id="<?php echo esc_attr( $id ); ?>"
									name="cf[<?php echo esc_attr( $key ); ?>]"
									value="<?php echo esc_attr( null === $value ? '' : (string) $value ); ?>" />
							<?php endif; ?>
							<?php if ( ! empty( $field['description'] ) ) : ?>
								<p class="description"><?php echo esc_html( (string) $field['description'] ); ?></p>
							<?php endif; ?>
						</td>
					</tr>
				<?php endforeach; ?>
			</table>
			<?php submit_button( __( 'Save fields', 'tbay-rewards' ), 'secondary' ); ?>
		</form>
		<?php
	}

	/**
	 * Define the fields themselves. Shown on the Privacy screen, because that
	 * is where "what this store holds about people" already lives.
	 */
	private function render_field_definitions(): void {
		$result = $this->api->request( 'GET', '/v1/contacts/fields' );
		$fields = is_wp_error( $result ) ? array() : ( $result['fields'] ?? array() );
		?>
		<h2><?php esc_html_e( 'Your own fields', 'tbay-rewards' ); ?></h2>
		<p class="description">
			<?php
			esc_html_e(
				'Fields this store keeps about its customers, beside the ones the platform keeps. They appear on every customer page and can be segmented on. A type cannot be changed once values are stored under it.',
				'tbay-rewards'
			);
			?>
		</p>
		<table class="widefat striped">
			<thead>
				<tr>
					<th><?php esc_html_e( 'Field', 'tbay-rewards' ); ?></th>
					<th><?php esc_html_e( 'Type', 'tbay-rewards' ); ?></th>
					<th><?php esc_html_e( 'Segment as', 'tbay-rewards' ); ?></th>
					<th></th>
				</tr>
			</thead>
			<tbody>
			<?php foreach ( $fields as $field ) : ?>
				<?php $key = (string) ( $field['key'] ?? '' ); ?>
				<tr>
					<td>
						<strong><?php echo esc_html( (string) ( $field['label'] ?? $key ) ); ?></strong><br />
						<code><?php echo esc_html( $key ); ?></code>
					</td>
					<td>
						<?php echo esc_html( (string) ( $field['kind'] ?? '' ) ); ?>
						<?php if ( ! empty( $field['options'] ) ) : ?>
							<p class="description"><?php echo esc_html( implode( ', ', (array) $field['options'] ) ); ?></p>
						<?php endif; ?>
					</td>
					<td><code>cf_<?php echo esc_html( $key ); ?></code></td>
					<td>
						<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" class="tbay-row-form"
							onsubmit="return confirm(<?php echo esc_attr( wp_json_encode( __( 'Remove this field? Every value stored under it goes too.', 'tbay-rewards' ) ) ); ?>);">
							<?php wp_nonce_field( 'tbay_manage' ); ?>
							<input type="hidden" name="action" value="tbay_manage" />
							<input type="hidden" name="tbay_action" value="delete_field" />
							<input type="hidden" name="tbay_screen" value="privacy" />
							<input type="hidden" name="key" value="<?php echo esc_attr( $key ); ?>" />
							<?php submit_button( __( 'Remove', 'tbay-rewards' ), 'small', '', false ); ?>
						</form>
					</td>
				</tr>
			<?php endforeach; ?>
			</tbody>
		</table>

		<h3><?php esc_html_e( 'Add a field', 'tbay-rewards' ); ?></h3>
		<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
			<?php wp_nonce_field( 'tbay_manage' ); ?>
			<input type="hidden" name="action" value="tbay_manage" />
			<input type="hidden" name="tbay_action" value="save_field" />
			<input type="hidden" name="tbay_screen" value="privacy" />
			<table class="form-table">
				<tr>
					<th scope="row"><label for="tbay-field-key"><?php esc_html_e( 'Key', 'tbay-rewards' ); ?></label></th>
					<td>
						<input type="text" id="tbay-field-key" name="key" class="regular-text"
							pattern="[a-z0-9_]{2,40}" required />
					</td>
				</tr>
				<tr>
					<th scope="row"><label for="tbay-field-label"><?php esc_html_e( 'Label', 'tbay-rewards' ); ?></label></th>
					<td><input type="text" id="tbay-field-label" name="label" class="regular-text" /></td>
				</tr>
				<tr>
					<th scope="row"><label for="tbay-field-kind"><?php esc_html_e( 'Type', 'tbay-rewards' ); ?></label></th>
					<td>
						<select id="tbay-field-kind" name="kind">
							<option value="text"><?php esc_html_e( 'Text', 'tbay-rewards' ); ?></option>
							<option value="number"><?php esc_html_e( 'Number', 'tbay-rewards' ); ?></option>
							<option value="date"><?php esc_html_e( 'Date', 'tbay-rewards' ); ?></option>
							<option value="boolean"><?php esc_html_e( 'Yes or no', 'tbay-rewards' ); ?></option>
							<option value="select"><?php esc_html_e( 'One of a list', 'tbay-rewards' ); ?></option>
						</select>
					</td>
				</tr>
				<tr>
					<th scope="row"><label for="tbay-field-options"><?php esc_html_e( 'Choices', 'tbay-rewards' ); ?></label></th>
					<td>
						<input type="text" id="tbay-field-options" name="options" class="large-text" />
						<p class="description"><?php esc_html_e( 'For a list field: the choices, separated by commas.', 'tbay-rewards' ); ?></p>
					</td>
				</tr>
			</table>
			<?php submit_button( __( 'Add field', 'tbay-rewards' ) ); ?>
		</form>
		<?php
	}

	private function do_save_field(): string|WP_Error {
		$key = $this->post( 'key' );
		if ( ! preg_match( '/^[a-z0-9_]{2,40}$/', $key ) ) {
			return new WP_Error(
				'tbay_bad_input',
				__( 'A field key is 2-40 characters of a-z, 0-9 or underscore.', 'tbay-rewards' )
			);
		}

		$payload = array( 'kind' => $this->post( 'kind', 'text' ) );
		$label = $this->post( 'label' );
		if ( '' !== $label ) {
			$payload['label'] = $label;
		}

		$options = array_values(
			array_filter( array_map( 'trim', explode( ',', $this->post( 'options' ) ) ) )
		);
		if ( ! empty( $options ) ) {
			$payload['options'] = $options;
		}

		$result = $this->api->request( 'PUT', '/v1/contacts/fields/' . rawurlencode( $key ), $payload );
		return is_wp_error( $result ) ? $result : __( 'Field saved.', 'tbay-rewards' );
	}

	private function do_delete_field(): string|WP_Error {
		$key = $this->post( 'key' );
		if ( '' === $key ) {
			return new WP_Error( 'tbay_bad_input', __( 'Which field?', 'tbay-rewards' ) );
		}
		$result = $this->api->request( 'DELETE', '/v1/contacts/fields/' . rawurlencode( $key ) );
		return is_wp_error( $result ) ? $result : __( 'Field removed.', 'tbay-rewards' );
	}

	private function do_save_field_values(): string|WP_Error {
		$contact_id = $this->post( 'contact_id' );
		if ( '' === $contact_id ) {
			return new WP_Error( 'tbay_bad_input', __( 'Which customer?', 'tbay-rewards' ) );
		}

		// phpcs:ignore WordPress.Security.NonceVerification.Missing -- checked in handle_post.
		$raw = isset( $_POST['cf'] ) && is_array( $_POST['cf'] ) ? wp_unslash( $_POST['cf'] ) : array();

		$values = array();
		foreach ( $raw as $key => $value ) {
			if ( ! is_string( $key ) || ! preg_match( '/^[a-z0-9_]{2,40}$/', $key ) ) {
				continue;
			}
			$text = is_scalar( $value ) ? trim( (string) $value ) : '';
			// An empty control clears the value rather than storing "".
			$values[ sanitize_text_field( $key ) ] = '' === $text ? null : sanitize_text_field( $text );
		}

		$result = $this->api->request(
			'PUT',
			'/v1/contacts/field-values',
			array( 'contactId' => $contact_id, 'values' => (object) $values )
		);
		return is_wp_error( $result ) ? $result : __( 'Fields saved.', 'tbay-rewards' );
	}


	// ── Merging duplicates ───────────────────────────────────────────────────

	/**
	 * Fold another record into the one on screen.
	 *
	 * On the customer page rather than a list, because the person doing it has
	 * to be looking at the record that survives. A merge is irreversible and it
	 * moves points, so "which one am I keeping" should never be a guess.
	 */
	private function render_merge_form( string $contact_id ): void {
		if ( '' === $contact_id ) {
			return;
		}

		$found = $this->api->request( 'GET', '/v1/contacts/duplicates', array(), array( 'limit' => 25 ) );
		$found = is_wp_error( $found ) ? array() : ( $found['duplicates'] ?? array() );

		// Only the groups this customer is actually in.
		$others = array();
		foreach ( $found as $group ) {
			$ids = (array) ( $group['contact_ids'] ?? array() );
			if ( ! in_array( $contact_id, $ids, true ) ) {
				continue;
			}
			foreach ( $ids as $id ) {
				if ( $id !== $contact_id ) {
					$others[ (string) $id ] = (string) ( $group['reason'] ?? '' );
				}
			}
		}
		?>
		<h3><?php esc_html_e( 'Merge a duplicate', 'tbay-rewards' ); ?></h3>
		<p class="description">
			<?php
			esc_html_e(
				'The record you are looking at is the one that survives, and it keeps its ID. Points from both are added together, history moves across, and the other record is deleted. This cannot be undone.',
				'tbay-rewards'
			);
			?>
		</p>

		<?php if ( ! empty( $others ) ) : ?>
			<p>
				<strong><?php esc_html_e( 'Possible duplicates found:', 'tbay-rewards' ); ?></strong>
				<?php foreach ( $others as $id => $reason ) : ?>
					<br /><code><?php echo esc_html( $id ); ?></code>
					<span class="description">(<?php echo esc_html( $reason ); ?>)</span>
				<?php endforeach; ?>
			</p>
		<?php endif; ?>

		<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" class="tbay-row-form"
			onsubmit="return confirm(<?php echo esc_attr( wp_json_encode( __( 'Merge permanently? The other record is deleted and its points are added to this one.', 'tbay-rewards' ) ) ); ?>);">
			<?php wp_nonce_field( 'tbay_manage' ); ?>
			<input type="hidden" name="action" value="tbay_manage" />
			<input type="hidden" name="tbay_action" value="merge_contacts" />
			<input type="hidden" name="tbay_screen" value="customers" />
			<input type="hidden" name="keep" value="<?php echo esc_attr( $contact_id ); ?>" />
			<label class="screen-reader-text" for="tbay-merge-id">
				<?php esc_html_e( 'Contact ID to merge in', 'tbay-rewards' ); ?>
			</label>
			<input type="text" id="tbay-merge-id" name="merge" class="regular-text"
				placeholder="<?php esc_attr_e( 'Contact ID of the duplicate', 'tbay-rewards' ); ?>" />
			<?php submit_button( __( 'Merge into this record', 'tbay-rewards' ), 'secondary', '', false ); ?>
		</form>
		<?php
	}

	private function do_merge_contacts(): string|WP_Error {
		$keep  = $this->post( 'keep' );
		$merge = $this->post( 'merge' );
		if ( '' === $keep || '' === $merge ) {
			return new WP_Error( 'tbay_bad_input', __( 'Both records are needed.', 'tbay-rewards' ) );
		}

		$result = $this->api->post(
			'/v1/contacts/merge',
			array( 'keep' => $keep, 'merge' => $merge )
		);
		if ( is_wp_error( $result ) ) {
			return $result;
		}

		$points = array_sum( array_map( 'intval', (array) ( $result['points_moved'] ?? array() ) ) );
		return sprintf(
			/* translators: %s: number of points moved. */
			__( 'Merged. %s points were carried across.', 'tbay-rewards' ),
			number_format_i18n( $points )
		);
	}


	// ── Access and audit ─────────────────────────────────────────────────────

	/**
	 * Who can do what, and what they did.
	 *
	 * Everything here needs an owner key. A store where one person holds one
	 * key never opens this screen; a store where three people share one wants
	 * it the first time somebody asks who adjusted a balance.
	 */
	private function screen_access(): void {
		$operators = $this->api->request( 'GET', '/v1/operators' );
		if ( is_wp_error( $operators ) ) {
			printf(
				'<div class="notice notice-warning"><p>%s</p></div>',
				esc_html__( 'This needs an owner key. The key in your settings is narrower than that.', 'tbay-rewards' )
			);
			return;
		}
		$operators = $operators['operators'] ?? array();

		$keys = $this->api->request( 'GET', '/v1/keys' );
		$keys = is_wp_error( $keys ) ? array() : ( $keys['keys'] ?? array() );

		$audit = $this->api->request( 'GET', '/v1/audit', array(), array( 'limit' => 50 ) );
		$audit = is_wp_error( $audit ) ? array() : ( $audit['entries'] ?? array() );

		$roles = array(
			'owner'    => __( 'Owner — everything, including keys and people', 'tbay-rewards' ),
			'manager'  => __( 'Manager — every operational change', 'tbay-rewards' ),
			'support'  => __( 'Support — read anything, adjust a balance', 'tbay-rewards' ),
			'readonly' => __( 'Read only', 'tbay-rewards' ),
		);
		?>
		<h2><?php esc_html_e( 'People', 'tbay-rewards' ); ?></h2>
		<table class="widefat striped">
			<thead><tr>
				<th><?php esc_html_e( 'Person', 'tbay-rewards' ); ?></th>
				<th><?php esc_html_e( 'Role', 'tbay-rewards' ); ?></th>
				<th><?php esc_html_e( 'Active', 'tbay-rewards' ); ?></th>
				<th></th>
			</tr></thead>
			<tbody>
			<?php foreach ( $operators as $operator ) : ?>
				<?php $email = (string) ( $operator['email'] ?? '' ); ?>
				<tr>
					<td>
						<strong><?php echo esc_html( (string) ( $operator['name'] ?? $email ) ); ?></strong><br />
						<code><?php echo esc_html( $email ); ?></code>
					</td>
					<td>
						<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" class="tbay-row-form">
							<?php wp_nonce_field( 'tbay_manage' ); ?>
							<input type="hidden" name="action" value="tbay_manage" />
							<input type="hidden" name="tbay_action" value="save_operator" />
							<input type="hidden" name="tbay_screen" value="access" />
							<input type="hidden" name="email" value="<?php echo esc_attr( $email ); ?>" />
							<select name="role">
								<?php foreach ( array_keys( $roles ) as $role ) : ?>
									<option value="<?php echo esc_attr( $role ); ?>"
										<?php selected( (string) ( $operator['role'] ?? '' ), $role ); ?>>
										<?php echo esc_html( $role ); ?>
									</option>
								<?php endforeach; ?>
							</select>
							<label>
								<input type="checkbox" name="active" value="1"
									<?php checked( empty( $operator['disabled_at'] ) ); ?> />
								<?php esc_html_e( 'Active', 'tbay-rewards' ); ?>
							</label>
							<?php submit_button( __( 'Save', 'tbay-rewards' ), 'small', '', false ); ?>
						</form>
					</td>
					<td><?php echo empty( $operator['disabled_at'] ) ? esc_html__( 'Yes', 'tbay-rewards' ) : esc_html__( 'No', 'tbay-rewards' ); ?></td>
					<td>
						<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" class="tbay-row-form"
							onsubmit="return confirm(<?php echo esc_attr( wp_json_encode( __( 'Remove this person? Their keys keep working — revoke those separately if you mean to.', 'tbay-rewards' ) ) ); ?>);">
							<?php wp_nonce_field( 'tbay_manage' ); ?>
							<input type="hidden" name="action" value="tbay_manage" />
							<input type="hidden" name="tbay_action" value="delete_operator" />
							<input type="hidden" name="tbay_screen" value="access" />
							<input type="hidden" name="email" value="<?php echo esc_attr( $email ); ?>" />
							<?php submit_button( __( 'Remove', 'tbay-rewards' ), 'small', '', false ); ?>
						</form>
					</td>
				</tr>
			<?php endforeach; ?>
			</tbody>
		</table>

		<h3><?php esc_html_e( 'Add a person', 'tbay-rewards' ); ?></h3>
		<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
			<?php wp_nonce_field( 'tbay_manage' ); ?>
			<input type="hidden" name="action" value="tbay_manage" />
			<input type="hidden" name="tbay_action" value="save_operator" />
			<input type="hidden" name="tbay_screen" value="access" />
			<input type="hidden" name="active" value="1" />
			<table class="form-table">
				<tr>
					<th scope="row"><label for="tbay-op-email"><?php esc_html_e( 'Email', 'tbay-rewards' ); ?></label></th>
					<td><input type="email" id="tbay-op-email" name="email" class="regular-text" required /></td>
				</tr>
				<tr>
					<th scope="row"><label for="tbay-op-name"><?php esc_html_e( 'Name', 'tbay-rewards' ); ?></label></th>
					<td><input type="text" id="tbay-op-name" name="name" class="regular-text" /></td>
				</tr>
				<tr>
					<th scope="row"><label for="tbay-op-role"><?php esc_html_e( 'Role', 'tbay-rewards' ); ?></label></th>
					<td>
						<select id="tbay-op-role" name="role">
							<?php foreach ( $roles as $role => $label ) : ?>
								<option value="<?php echo esc_attr( $role ); ?>" <?php selected( 'support', $role ); ?>>
									<?php echo esc_html( $label ); ?>
								</option>
							<?php endforeach; ?>
						</select>
					</td>
				</tr>
			</table>
			<?php submit_button( __( 'Add person', 'tbay-rewards' ) ); ?>
		</form>

		<h2><?php esc_html_e( 'Keys', 'tbay-rewards' ); ?></h2>
		<?php
		// Shown once and then gone, so a reload or a shared screenshot of the
		// URL does not carry it.
		$issued = get_transient( 'tbay_issued_key_' . get_current_user_id() );
		if ( is_string( $issued ) && '' !== $issued ) {
			delete_transient( 'tbay_issued_key_' . get_current_user_id() );
		}
		?>
		<?php if ( is_string( $issued ) && '' !== $issued ) : ?>
			<div class="notice notice-success">
				<p><strong><?php esc_html_e( 'Copy this now — it is stored as a hash and cannot be shown again.', 'tbay-rewards' ); ?></strong></p>
				<p><code><?php echo esc_html( $issued ); ?></code></p>
			</div>
		<?php endif; ?>
		<table class="widefat striped">
			<thead><tr>
				<th><?php esc_html_e( 'Key', 'tbay-rewards' ); ?></th>
				<th><?php esc_html_e( 'Role', 'tbay-rewards' ); ?></th>
				<th><?php esc_html_e( 'Last used', 'tbay-rewards' ); ?></th>
				<th></th>
			</tr></thead>
			<tbody>
			<?php foreach ( $keys as $key ) : ?>
				<?php if ( 'secret' !== ( $key['kind'] ?? '' ) || ! empty( $key['revoked_at'] ) ) : ?>
					<?php continue; ?>
				<?php endif; ?>
				<tr>
					<td>
						<code><?php echo esc_html( (string) ( $key['key_id'] ?? '' ) ); ?></code><br />
						<span class="description">
							<?php echo esc_html( (string) ( $key['operator_email'] ?? $key['label'] ?? '' ) ); ?>
						</span>
					</td>
					<td><?php echo esc_html( (string) ( $key['role'] ?? 'owner' ) ); ?></td>
					<td>
						<?php
						echo empty( $key['last_used_at'] )
							? esc_html__( 'Never', 'tbay-rewards' )
							: esc_html( mysql2date( get_option( 'date_format' ), (string) $key['last_used_at'] ) );
						?>
					</td>
					<td>
						<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" class="tbay-row-form"
							onsubmit="return confirm(<?php echo esc_attr( wp_json_encode( __( 'Revoke this key? Anything using it stops working immediately.', 'tbay-rewards' ) ) ); ?>);">
							<?php wp_nonce_field( 'tbay_manage' ); ?>
							<input type="hidden" name="action" value="tbay_manage" />
							<input type="hidden" name="tbay_action" value="revoke_key" />
							<input type="hidden" name="tbay_screen" value="access" />
							<input type="hidden" name="key_id" value="<?php echo esc_attr( (string) ( $key['key_id'] ?? '' ) ); ?>" />
							<?php submit_button( __( 'Revoke', 'tbay-rewards' ), 'small', '', false ); ?>
						</form>
					</td>
				</tr>
			<?php endforeach; ?>
			</tbody>
		</table>

		<h3><?php esc_html_e( 'Issue a key', 'tbay-rewards' ); ?></h3>
		<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
			<?php wp_nonce_field( 'tbay_manage' ); ?>
			<input type="hidden" name="action" value="tbay_manage" />
			<input type="hidden" name="tbay_action" value="issue_key" />
			<input type="hidden" name="tbay_screen" value="access" />
			<table class="form-table">
				<tr>
					<th scope="row"><label for="tbay-key-label"><?php esc_html_e( 'What it is for', 'tbay-rewards' ); ?></label></th>
					<td><input type="text" id="tbay-key-label" name="label" class="regular-text" /></td>
				</tr>
				<tr>
					<th scope="row"><label for="tbay-key-operator"><?php esc_html_e( 'Person', 'tbay-rewards' ); ?></label></th>
					<td>
						<select id="tbay-key-operator" name="operator_email">
							<option value=""><?php esc_html_e( '— nobody in particular —', 'tbay-rewards' ); ?></option>
							<?php foreach ( $operators as $operator ) : ?>
								<option value="<?php echo esc_attr( (string) ( $operator['email'] ?? '' ) ); ?>">
									<?php echo esc_html( (string) ( $operator['email'] ?? '' ) ); ?>
								</option>
							<?php endforeach; ?>
						</select>
					</td>
				</tr>
				<tr>
					<th scope="row"><label for="tbay-key-role"><?php esc_html_e( 'Role', 'tbay-rewards' ); ?></label></th>
					<td>
						<select id="tbay-key-role" name="role">
							<option value=""><?php esc_html_e( '— whatever the person has —', 'tbay-rewards' ); ?></option>
							<?php foreach ( $roles as $role => $label ) : ?>
								<option value="<?php echo esc_attr( $role ); ?>"><?php echo esc_html( $label ); ?></option>
							<?php endforeach; ?>
						</select>
						<p class="description"><?php esc_html_e( 'The narrower of the two applies.', 'tbay-rewards' ); ?></p>
					</td>
				</tr>
			</table>
			<?php submit_button( __( 'Issue key', 'tbay-rewards' ) ); ?>
		</form>

		<h2><?php esc_html_e( 'What was done', 'tbay-rewards' ); ?></h2>
		<p class="description">
			<?php esc_html_e( 'Changes only — reads are not recorded. Refusals appear here too.', 'tbay-rewards' ); ?>
		</p>
		<table class="widefat striped">
			<thead><tr>
				<th><?php esc_html_e( 'When', 'tbay-rewards' ); ?></th>
				<th><?php esc_html_e( 'Who', 'tbay-rewards' ); ?></th>
				<th><?php esc_html_e( 'What', 'tbay-rewards' ); ?></th>
				<th><?php esc_html_e( 'Result', 'tbay-rewards' ); ?></th>
			</tr></thead>
			<tbody>
			<?php foreach ( $audit as $entry ) : ?>
				<tr>
					<td><?php echo esc_html( mysql2date( get_option( 'date_format' ) . ' H:i', (string) ( $entry['created_at'] ?? '' ) ) ); ?></td>
					<td>
						<?php echo esc_html( (string) ( $entry['operator_email'] ?? $entry['actor_label'] ?? '—' ) ); ?><br />
						<span class="description"><?php echo esc_html( (string) ( $entry['role'] ?? '' ) ); ?></span>
					</td>
					<td>
						<code><?php echo esc_html( (string) ( $entry['action'] ?? '' ) ); ?></code>
						<?php if ( ! empty( $entry['detail'] ) ) : ?>
							<p class="description"><?php echo esc_html( wp_json_encode( $entry['detail'] ) ); ?></p>
						<?php endif; ?>
					</td>
					<td><?php echo esc_html( (string) ( $entry['status'] ?? '' ) ); ?></td>
				</tr>
			<?php endforeach; ?>
			</tbody>
		</table>
		<?php
	}

	private function do_save_operator(): string|WP_Error {
		$email = $this->post( 'email' );
		if ( ! is_email( $email ) ) {
			return new WP_Error( 'tbay_bad_input', __( 'That is not an email address.', 'tbay-rewards' ) );
		}

		$payload = array(
			'email'    => $email,
			'disabled' => ! isset( $_POST['active'] ),
		);
		foreach ( array( 'name', 'role' ) as $field ) {
			$value = $this->post( $field );
			if ( '' !== $value ) {
				$payload[ $field ] = $value;
			}
		}

		$result = $this->api->request( 'PUT', '/v1/operators', $payload );
		return is_wp_error( $result ) ? $result : __( 'Saved.', 'tbay-rewards' );
	}

	private function do_delete_operator(): string|WP_Error {
		$email = $this->post( 'email' );
		if ( '' === $email ) {
			return new WP_Error( 'tbay_bad_input', __( 'Which person?', 'tbay-rewards' ) );
		}
		$result = $this->api->request( 'DELETE', '/v1/operators/' . rawurlencode( $email ) );
		return is_wp_error( $result ) ? $result : __( 'Removed. Their keys still work — revoke those separately.', 'tbay-rewards' );
	}

	/**
	 * Issue a key and show it once.
	 *
	 * Carried back in the redirect rather than stored: the platform keeps only
	 * a hash, so there is nothing to show a second time, and writing it into an
	 * option would put the one copy somewhere it was never meant to be.
	 */
	private function do_issue_key(): string|WP_Error {
		// Only what was filled in: an empty role means "whatever the person
		// has", and sending '' would be a role the API does not know.
		$payload = array();
		$fields  = array(
			'label'          => 'label',
			'operator_email' => 'operatorEmail',
			'role'           => 'role',
		);
		foreach ( $fields as $form_field => $api_field ) {
			$value = $this->post( $form_field );
			if ( '' !== $value ) {
				$payload[ $api_field ] = $value;
			}
		}

		$result = $this->api->post( '/v1/keys', $payload );
		if ( is_wp_error( $result ) ) {
			return $result;
		}

		// Held for this admin for one minute, not put in the URL. A secret in a
		// query string lands in browser history and in the access log of every
		// server, proxy and CDN between here and the browser — places nobody
		// rotates a key out of.
		set_transient(
			'tbay_issued_key_' . get_current_user_id(),
			(string) ( $result['secret'] ?? '' ),
			MINUTE_IN_SECONDS
		);

		$this->redirect_back( 'access', __( 'Key issued.', 'tbay-rewards' ) );
	}

	private function do_revoke_key(): string|WP_Error {
		$key_id = $this->post( 'key_id' );
		if ( '' === $key_id ) {
			return new WP_Error( 'tbay_bad_input', __( 'Which key?', 'tbay-rewards' ) );
		}
		$result = $this->api->request( 'DELETE', '/v1/keys/' . rawurlencode( $key_id ) );
		return is_wp_error( $result ) ? $result : __( 'Key revoked.', 'tbay-rewards' );
	}


	// ── Reports ──────────────────────────────────────────────────────────────

	/**
	 * Build a report, run it, and have it arrive on Monday.
	 *
	 * The dimension and measure lists come from the platform, not from here —
	 * a hard-coded copy in the plugin is a copy that goes stale the first time
	 * a new measure is added server-side.
	 */
	private function screen_reports(): void {
		$catalogue = $this->api->request( 'GET', '/v1/saved-reports/catalogue' );
		$sources   = is_wp_error( $catalogue ) ? array() : ( $catalogue['sources'] ?? array() );

		$saved = $this->api->request( 'GET', '/v1/saved-reports' );
		$reports   = is_wp_error( $saved ) ? array() : ( $saved['reports'] ?? array() );
		$schedules = is_wp_error( $saved ) ? array() : ( $saved['schedules'] ?? array() );

		$by_report = array();
		foreach ( $schedules as $schedule ) {
			$by_report[ (string) ( $schedule['report_key'] ?? '' ) ] = $schedule;
		}

		$viewing = $this->query( 'report' );
		if ( '' !== $viewing ) {
			$this->render_report_results( $viewing );
		}
		?>
		<h2><?php esc_html_e( 'Saved reports', 'tbay-rewards' ); ?></h2>
		<?php if ( empty( $reports ) ) : ?>
			<p class="description">
				<?php esc_html_e( 'None yet. Build one below — revenue by campaign, points by rule, whatever you need to see each week.', 'tbay-rewards' ); ?>
			</p>
		<?php else : ?>
			<table class="widefat striped">
				<thead><tr>
					<th><?php esc_html_e( 'Report', 'tbay-rewards' ); ?></th>
					<th><?php esc_html_e( 'Shows', 'tbay-rewards' ); ?></th>
					<th><?php esc_html_e( 'Emailed', 'tbay-rewards' ); ?></th>
					<th></th>
				</tr></thead>
				<tbody>
				<?php foreach ( $reports as $report ) : ?>
					<?php
					$key        = (string) ( $report['key'] ?? '' );
					$definition = is_array( $report['definition'] ?? null ) ? $report['definition'] : array();
					$schedule   = $by_report[ $key ] ?? null;
					?>
					<tr>
						<td>
							<strong><?php echo esc_html( (string) ( $report['name'] ?? $key ) ); ?></strong><br />
							<code><?php echo esc_html( $key ); ?></code>
						</td>
						<td>
							<?php
							echo esc_html(
								sprintf(
									/* translators: 1: source, 2: measures, 3: dimensions */
									__( '%1$s — %2$s by %3$s', 'tbay-rewards' ),
									(string) ( $definition['source'] ?? '' ),
									implode( ', ', (array) ( $definition['measures'] ?? array() ) ),
									implode( ', ', (array) ( $definition['dimensions'] ?? array() ) ) ?: __( 'nothing', 'tbay-rewards' )
								)
							);
							?>
						</td>
						<td>
							<?php if ( $schedule && ! empty( $schedule['enabled'] ) ) : ?>
								<?php
								echo esc_html(
									sprintf(
										/* translators: 1: cadence, 2: recipient count */
										__( '%1$s to %2$s', 'tbay-rewards' ),
										(string) ( $schedule['cadence'] ?? '' ),
										implode( ', ', (array) ( $schedule['recipients'] ?? array() ) )
									)
								);
								?>
							<?php else : ?>
								—
							<?php endif; ?>
						</td>
						<td>
							<a class="button button-small"
								href="<?php echo esc_url( add_query_arg( array( 'page' => 'tbay-manage-reports', 'report' => $key ), admin_url( 'admin.php' ) ) ); ?>">
								<?php esc_html_e( 'View', 'tbay-rewards' ); ?>
							</a>
							<?php if ( $schedule ) : ?>
								<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" class="tbay-row-form">
									<?php wp_nonce_field( 'tbay_manage' ); ?>
									<input type="hidden" name="action" value="tbay_manage" />
									<input type="hidden" name="tbay_action" value="send_report" />
									<input type="hidden" name="tbay_screen" value="reports" />
									<input type="hidden" name="key" value="<?php echo esc_attr( $key ); ?>" />
									<?php submit_button( __( 'Send now', 'tbay-rewards' ), 'small', '', false ); ?>
								</form>
							<?php endif; ?>
							<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" class="tbay-row-form"
								onsubmit="return confirm(<?php echo esc_attr( wp_json_encode( __( 'Delete this report?', 'tbay-rewards' ) ) ); ?>);">
								<?php wp_nonce_field( 'tbay_manage' ); ?>
								<input type="hidden" name="action" value="tbay_manage" />
								<input type="hidden" name="tbay_action" value="delete_report" />
								<input type="hidden" name="tbay_screen" value="reports" />
								<input type="hidden" name="key" value="<?php echo esc_attr( $key ); ?>" />
								<?php submit_button( __( 'Delete', 'tbay-rewards' ), 'small', '', false ); ?>
							</form>
						</td>
					</tr>

					<tr>
						<td colspan="4">
							<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" class="tbay-row-form">
								<?php wp_nonce_field( 'tbay_manage' ); ?>
								<input type="hidden" name="action" value="tbay_manage" />
								<input type="hidden" name="tbay_action" value="schedule_report" />
								<input type="hidden" name="tbay_screen" value="reports" />
								<input type="hidden" name="key" value="<?php echo esc_attr( $key ); ?>" />
								<label>
									<?php esc_html_e( 'Email', 'tbay-rewards' ); ?>
									<select name="cadence">
										<?php foreach ( array( 'daily', 'weekly', 'monthly' ) as $cadence ) : ?>
											<option value="<?php echo esc_attr( $cadence ); ?>"
												<?php selected( (string) ( $schedule['cadence'] ?? 'weekly' ), $cadence ); ?>>
												<?php echo esc_html( $cadence ); ?>
											</option>
										<?php endforeach; ?>
									</select>
								</label>
								<label>
									<?php esc_html_e( 'at', 'tbay-rewards' ); ?>
									<input type="number" name="hour" min="0" max="23" class="small-text"
										value="<?php echo esc_attr( (string) ( $schedule['hour'] ?? 7 ) ); ?>" />
									<?php esc_html_e( 'o’clock, your time', 'tbay-rewards' ); ?>
								</label>
								<label class="screen-reader-text" for="tbay-rep-to-<?php echo esc_attr( $key ); ?>">
									<?php esc_html_e( 'Recipients', 'tbay-rewards' ); ?>
								</label>
								<input type="text" id="tbay-rep-to-<?php echo esc_attr( $key ); ?>" name="recipients"
									class="regular-text"
									placeholder="<?php esc_attr_e( 'owner@shop.example, finance@shop.example', 'tbay-rewards' ); ?>"
									value="<?php echo esc_attr( implode( ', ', (array) ( $schedule['recipients'] ?? array() ) ) ); ?>" />
								<?php submit_button( __( 'Save schedule', 'tbay-rewards' ), 'small', '', false ); ?>
							</form>
						</td>
					</tr>
				<?php endforeach; ?>
				</tbody>
			</table>
		<?php endif; ?>

		<h3><?php esc_html_e( 'Build a report', 'tbay-rewards' ); ?></h3>
		<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
			<?php wp_nonce_field( 'tbay_manage' ); ?>
			<input type="hidden" name="action" value="tbay_manage" />
			<input type="hidden" name="tbay_action" value="save_report" />
			<input type="hidden" name="tbay_screen" value="reports" />
			<table class="form-table">
				<tr>
					<th scope="row"><label for="tbay-rep-key"><?php esc_html_e( 'Key', 'tbay-rewards' ); ?></label></th>
					<td><input type="text" id="tbay-rep-key" name="key" class="regular-text"
						pattern="[a-z0-9_]{2,64}" required /></td>
				</tr>
				<tr>
					<th scope="row"><label for="tbay-rep-name"><?php esc_html_e( 'Name', 'tbay-rewards' ); ?></label></th>
					<td><input type="text" id="tbay-rep-name" name="name" class="regular-text" /></td>
				</tr>
				<tr>
					<th scope="row"><label for="tbay-rep-source"><?php esc_html_e( 'About', 'tbay-rewards' ); ?></label></th>
					<td>
						<select id="tbay-rep-source" name="source">
							<?php foreach ( $sources as $source ) : ?>
								<option value="<?php echo esc_attr( (string) ( $source['key'] ?? '' ) ); ?>">
									<?php echo esc_html( (string) ( $source['label'] ?? '' ) ); ?>
								</option>
							<?php endforeach; ?>
						</select>
					</td>
				</tr>
				<tr>
					<th scope="row"><label for="tbay-rep-dims"><?php esc_html_e( 'Grouped by', 'tbay-rewards' ); ?></label></th>
					<td>
						<input type="text" id="tbay-rep-dims" name="dimensions" class="regular-text"
							placeholder="month, campaign" />
						<p class="description"><?php esc_html_e( 'Up to four, separated by commas. Leave empty for one total row.', 'tbay-rewards' ); ?></p>
					</td>
				</tr>
				<tr>
					<th scope="row"><label for="tbay-rep-measures"><?php esc_html_e( 'Showing', 'tbay-rewards' ); ?></label></th>
					<td>
						<input type="text" id="tbay-rep-measures" name="measures" class="regular-text"
							placeholder="orders, revenue" required />
					</td>
				</tr>
				<tr>
					<th scope="row"><label for="tbay-rep-days"><?php esc_html_e( 'Covering', 'tbay-rewards' ); ?></label></th>
					<td>
						<input type="number" id="tbay-rep-days" name="days" min="1" max="3650" class="small-text" value="90" />
						<?php esc_html_e( 'days. Empty for everything.', 'tbay-rewards' ); ?>
					</td>
				</tr>
			</table>
			<?php submit_button( __( 'Save report', 'tbay-rewards' ) ); ?>
		</form>

		<?php $this->render_report_catalogue( $sources ); ?>
		<?php
	}

	/**
	 * @param array<int,array<string,mixed>> $sources The catalogue.
	 */
	private function render_report_catalogue( array $sources ): void {
		?>
		<h3><?php esc_html_e( 'What you can ask for', 'tbay-rewards' ); ?></h3>
		<table class="widefat striped">
			<thead><tr>
				<th><?php esc_html_e( 'About', 'tbay-rewards' ); ?></th>
				<th><?php esc_html_e( 'Can be grouped by', 'tbay-rewards' ); ?></th>
				<th><?php esc_html_e( 'Can show', 'tbay-rewards' ); ?></th>
			</tr></thead>
			<tbody>
			<?php foreach ( $sources as $source ) : ?>
				<tr>
					<td>
						<strong><?php echo esc_html( (string) ( $source['label'] ?? '' ) ); ?></strong><br />
						<code><?php echo esc_html( (string) ( $source['key'] ?? '' ) ); ?></code>
					</td>
					<td>
						<?php
						echo esc_html(
							implode(
								', ',
								array_map(
									static fn( $one ) => (string) ( $one['key'] ?? '' ),
									(array) ( $source['dimensions'] ?? array() )
								)
							)
						);
						?>
					</td>
					<td>
						<?php
						echo esc_html(
							implode(
								', ',
								array_map(
									static fn( $one ) => (string) ( $one['key'] ?? '' ),
									(array) ( $source['measures'] ?? array() )
								)
							)
						);
						?>
					</td>
				</tr>
			<?php endforeach; ?>
			</tbody>
		</table>
		<?php
	}

	private function render_report_results( string $key ): void {
		$result = $this->api->request( 'GET', '/v1/saved-reports/' . rawurlencode( $key ) . '/run' );
		if ( is_wp_error( $result ) ) {
			printf( '<div class="notice notice-error"><p>%s</p></div>', esc_html( $result->get_error_message() ) );
			return;
		}

		$columns = (array) ( $result['columns'] ?? array() );
		$rows    = (array) ( $result['rows'] ?? array() );
		?>
		<h2><?php echo esc_html( $key ); ?></h2>
		<?php if ( ! empty( $result['truncated'] ) ) : ?>
			<div class="notice notice-warning inline"><p>
				<?php esc_html_e( 'Showing the first rows only. Narrow the window or add a limit.', 'tbay-rewards' ); ?>
			</p></div>
		<?php endif; ?>
		<table class="widefat striped">
			<thead><tr>
				<?php foreach ( $columns as $column ) : ?>
					<th><?php echo esc_html( (string) ( $column['label'] ?? '' ) ); ?></th>
				<?php endforeach; ?>
			</tr></thead>
			<tbody>
			<?php foreach ( $rows as $row ) : ?>
				<tr>
					<?php foreach ( $columns as $column ) : ?>
						<?php
						$field = (string) ( $column['key'] ?? '' );
						$value = $row[ $field ] ?? '';
						?>
						<td>
							<?php
							echo esc_html(
								'money' === ( $column['format'] ?? '' )
									? $this->money( (int) $value )
									: (string) $value
							);
							?>
						</td>
					<?php endforeach; ?>
				</tr>
			<?php endforeach; ?>
			</tbody>
		</table>
		<p class="description">
			<?php
			printf(
				/* translators: %s: number of rows */
				esc_html__( '%s rows.', 'tbay-rewards' ),
				esc_html( number_format_i18n( count( $rows ) ) )
			);
			?>
		</p>
		<?php
	}

	private function do_save_report(): string|WP_Error {
		$key = $this->post( 'key' );
		if ( ! preg_match( '/^[a-z0-9_]{2,64}$/', $key ) ) {
			return new WP_Error(
				'tbay_bad_input',
				__( 'A report key is 2-64 characters of a-z, 0-9 or underscore.', 'tbay-rewards' )
			);
		}

		$split = static fn( string $raw ): array => array_values(
			array_filter( array_map( 'trim', explode( ',', $raw ) ) )
		);

		$days = trim( $this->post( 'days' ) );

		$definition = array(
			'source'     => $this->post( 'source', 'orders' ),
			'dimensions' => $split( $this->post( 'dimensions' ) ),
			'measures'   => $split( $this->post( 'measures' ) ),
			// An empty field means "everything", which the API expresses as
			// null rather than zero — a zero-day window would report on
			// nothing at all.
			'days'       => '' === $days ? null : (int) $days,
		);

		if ( empty( $definition['measures'] ) ) {
			return new WP_Error( 'tbay_bad_input', __( 'A report needs at least one measure.', 'tbay-rewards' ) );
		}

		$payload = array( 'definition' => $definition );
		$name = $this->post( 'name' );
		if ( '' !== $name ) {
			$payload['name'] = $name;
		}

		$result = $this->api->request( 'PUT', '/v1/saved-reports/' . rawurlencode( $key ), $payload );
		return is_wp_error( $result ) ? $result : __( 'Report saved.', 'tbay-rewards' );
	}

	private function do_delete_report(): string|WP_Error {
		$key = $this->post( 'key' );
		if ( '' === $key ) {
			return new WP_Error( 'tbay_bad_input', __( 'Which report?', 'tbay-rewards' ) );
		}
		$result = $this->api->request( 'DELETE', '/v1/saved-reports/' . rawurlencode( $key ) );
		return is_wp_error( $result ) ? $result : __( 'Report deleted.', 'tbay-rewards' );
	}

	private function do_schedule_report(): string|WP_Error {
		$key = $this->post( 'key' );
		if ( '' === $key ) {
			return new WP_Error( 'tbay_bad_input', __( 'Which report?', 'tbay-rewards' ) );
		}

		$recipients = array_values(
			array_filter(
				array_map( 'trim', explode( ',', $this->post( 'recipients' ) ) ),
				static fn( string $address ): bool => is_email( $address ) !== false
			)
		);
		if ( empty( $recipients ) ) {
			return new WP_Error(
				'tbay_bad_input',
				__( 'Give at least one email address to send it to.', 'tbay-rewards' )
			);
		}

		$result = $this->api->request(
			'PUT',
			'/v1/saved-reports/' . rawurlencode( $key ) . '/schedule',
			array(
				'cadence'    => $this->post( 'cadence', 'weekly' ),
				'hour'       => (int) $this->post( 'hour', '7' ),
				'recipients' => $recipients,
				'enabled'    => true,
			)
		);
		return is_wp_error( $result ) ? $result : __( 'Schedule saved.', 'tbay-rewards' );
	}

	private function do_send_report(): string|WP_Error {
		$key = $this->post( 'key' );
		if ( '' === $key ) {
			return new WP_Error( 'tbay_bad_input', __( 'Which report?', 'tbay-rewards' ) );
		}
		$result = $this->api->post( '/v1/saved-reports/' . rawurlencode( $key ) . '/send', array() );
		if ( is_wp_error( $result ) ) {
			return $result;
		}
		return sprintf(
			/* translators: %s: number of recipients */
			__( 'Sent to %s.', 'tbay-rewards' ),
			number_format_i18n( (int) ( $result['sent'] ?? 0 ) )
		);
	}

}
