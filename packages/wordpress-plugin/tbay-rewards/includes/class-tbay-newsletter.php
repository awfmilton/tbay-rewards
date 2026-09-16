<?php
/**
 * Newsletter signup form, shortcode and block.
 *
 * @package TBAY_Rewards
 */

declare( strict_types = 1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Renders the signup form and proxies submissions.
 *
 * The form posts to WordPress rather than straight to the platform, so the
 * submission carries a nonce, can be rate limited per IP, and works with
 * JavaScript disabled.
 */
class TBAY_Rewards_Newsletter {

	public function __construct( private TBAY_Rewards_API $api ) {
		add_shortcode( 'tbay_newsletter', array( $this, 'render' ) );
		add_action( 'rest_api_init', array( $this, 'register_routes' ) );
		add_action( 'init', array( $this, 'register_block' ) );

		// Progressive enhancement: the no-JS path posts back to the same page.
		add_action( 'admin_post_nopriv_tbay_subscribe', array( $this, 'handle_form_post' ) );
		add_action( 'admin_post_tbay_subscribe', array( $this, 'handle_form_post' ) );
	}

	/**
	 * @param array<string,string>|string $atts Shortcode attributes.
	 */
	public function render( $atts = array() ): string {
		$atts = shortcode_atts(
			array(
				'list'        => 'newsletter',
				'title'       => __( 'Join the list', 'tbay-rewards' ),
				'description' => __( 'Get new arrivals and offers by email — and earn reward points for joining.', 'tbay-rewards' ),
				'button'      => __( 'Subscribe', 'tbay-rewards' ),
				'name_field'  => 'yes',
				'source'      => 'shortcode',
			),
			is_array( $atts ) ? $atts : array(),
			'tbay_newsletter'
		);

		if ( '' === $this->api->public_key() ) {
			return current_user_can( 'manage_options' )
				? '<p class="tbay-notice">' . esc_html__( 'TBAY Rewards: add your site key in Settings → TBAY Rewards to show this form.', 'tbay-rewards' ) . '</p>'
				: '';
		}

		$current = wp_get_current_user();

		// Feedback for the no-JavaScript path, which posts to admin-post.php and
		// redirects back here. Without this the page silently reloaded and the
		// subscriber had no idea whether it had worked.
		$notice = '';
		if ( isset( $_GET['tbay_subscribed'] ) ) {
			switch ( sanitize_key( wp_unslash( $_GET['tbay_subscribed'] ) ) ) {
				case 'pending':
					$notice = __( 'Almost there — check your inbox to confirm.', 'tbay-rewards' );
					break;
				case 'subscribed':
					$notice = __( 'You are subscribed. Welcome aboard.', 'tbay-rewards' );
					break;
				case 'already_subscribed':
					$notice = __( 'You are already subscribed.', 'tbay-rewards' );
					break;
				default:
					$notice = __( 'Something went wrong. Please try again.', 'tbay-rewards' );
			}
		}

		ob_start();
		?>
		<form class="tbay-newsletter"
			method="post"
			action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>"
			data-tbay-newsletter
			data-list="<?php echo esc_attr( $atts['list'] ); ?>"
			data-source="<?php echo esc_attr( $atts['source'] ); ?>">

			<?php wp_nonce_field( 'tbay_subscribe', 'tbay_nonce' ); ?>
			<input type="hidden" name="action" value="tbay_subscribe">
			<input type="hidden" name="list" value="<?php echo esc_attr( $atts['list'] ); ?>">
			<input type="hidden" name="source" value="<?php echo esc_attr( $atts['source'] ); ?>">
			<input type="hidden" name="redirect_to" value="<?php echo esc_url( (string) get_permalink() ); ?>">

			<?php if ( '' !== $atts['title'] ) : ?>
				<h3 class="tbay-newsletter__title"><?php echo esc_html( $atts['title'] ); ?></h3>
			<?php endif; ?>

			<?php if ( '' !== $atts['description'] ) : ?>
				<p class="tbay-newsletter__description"><?php echo esc_html( $atts['description'] ); ?></p>
			<?php endif; ?>

			<div class="tbay-newsletter__fields">
				<?php if ( 'yes' === $atts['name_field'] ) : ?>
					<label class="tbay-field">
						<span class="screen-reader-text"><?php esc_html_e( 'Your name', 'tbay-rewards' ); ?></span>
						<input type="text" name="name" autocomplete="name"
							placeholder="<?php esc_attr_e( 'Your name', 'tbay-rewards' ); ?>"
							value="<?php echo esc_attr( $current->display_name ?? '' ); ?>">
					</label>
				<?php endif; ?>

				<label class="tbay-field">
					<span class="screen-reader-text"><?php esc_html_e( 'Email address', 'tbay-rewards' ); ?></span>
					<input type="email" name="email" required autocomplete="email"
						placeholder="<?php esc_attr_e( 'you@example.com', 'tbay-rewards' ); ?>"
						value="<?php echo esc_attr( $current->user_email ?? '' ); ?>">
				</label>

				<button type="submit" class="tbay-button"><?php echo esc_html( $atts['button'] ); ?></button>
			</div>

			<?php // Honeypot. Hidden from people, irresistible to bots. ?>
			<div class="tbay-hp" aria-hidden="true">
				<label>
					<?php esc_html_e( 'Leave this field empty', 'tbay-rewards' ); ?>
					<input type="text" name="website" tabindex="-1" autocomplete="off">
				</label>
			</div>

			<p class="tbay-newsletter__status" role="status" aria-live="polite">
				<?php echo esc_html( $notice ); ?>
			</p>
		</form>
		<?php
		return (string) ob_get_clean();
	}

	public function register_block(): void {
		if ( ! function_exists( 'register_block_type' ) ) {
			return;
		}

		// Registering the editor script is what puts the block in the inserter.
		// Server-side registration alone makes it renderable but unreachable.
		wp_register_script(
			'tbay-newsletter-block',
			TBAY_REWARDS_URL . 'assets/tbay-block.js',
			array( 'wp-blocks', 'wp-element', 'wp-i18n', 'wp-block-editor', 'wp-components' ),
			TBAY_REWARDS_VERSION,
			true
		);

		register_block_type(
			'tbay/newsletter',
			array(
				'api_version'     => 3,
				'title'           => __( 'TBAY newsletter signup', 'tbay-rewards' ),
				'description'     => __( 'A double opt-in signup form that awards reward points.', 'tbay-rewards' ),
				'category'        => 'widgets',
				'icon'            => 'email',
				'editor_script'   => 'tbay-newsletter-block',
				'attributes'      => array(
					'list'        => array( 'type' => 'string', 'default' => 'newsletter' ),
					'title'       => array( 'type' => 'string', 'default' => '' ),
					'description' => array( 'type' => 'string', 'default' => '' ),
					'button'      => array( 'type' => 'string', 'default' => '' ),
				),
				'render_callback' => function ( array $attributes ): string {
					return $this->render(
						array_filter(
							array(
								'list'        => $attributes['list'] ?? 'newsletter',
								'title'       => $attributes['title'] ?? '',
								'description' => $attributes['description'] ?? '',
								'button'      => $attributes['button'] ?? '',
								'source'      => 'block',
							),
							static fn( $value ) => '' !== $value
						)
					);
				},
			)
		);
	}

	public function register_routes(): void {
		register_rest_route(
			'tbay/v1',
			'/subscribe',
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => array( $this, 'handle_rest_subscribe' ),
				'permission_callback' => '__return_true',
				'args'                => array(
					'email'   => array( 'required' => true, 'type' => 'string' ),
					'name'    => array( 'required' => false, 'type' => 'string' ),
					'list'    => array( 'required' => false, 'type' => 'string' ),
					'source'  => array( 'required' => false, 'type' => 'string' ),
					'visitor' => array( 'required' => false, 'type' => 'string' ),
				),
			)
		);
	}

	public function handle_rest_subscribe( WP_REST_Request $request ): WP_REST_Response {
		if ( '' !== (string) $request->get_param( 'website' ) ) {
			// Honeypot tripped: answer as though it worked, do nothing.
			return new WP_REST_Response( array( 'status' => 'pending' ), 200 );
		}

		if ( ! $this->rate_limit_ok() ) {
			return new WP_REST_Response(
				array( 'message' => __( 'Too many attempts. Please try again in a few minutes.', 'tbay-rewards' ) ),
				429
			);
		}

		$result = $this->subscribe(
			sanitize_email( (string) $request->get_param( 'email' ) ),
			sanitize_text_field( (string) $request->get_param( 'name' ) ),
			sanitize_key( (string) ( $request->get_param( 'list' ) ?: 'newsletter' ) ),
			sanitize_text_field( (string) ( $request->get_param( 'source' ) ?: 'rest' ) ),
			sanitize_text_field( (string) $request->get_param( 'visitor' ) )
		);

		if ( is_wp_error( $result ) ) {
			return new WP_REST_Response( array( 'message' => $result->get_error_message() ), 400 );
		}

		return new WP_REST_Response( $result, 200 );
	}

	/** No-JavaScript fallback: posts to admin-post.php and redirects back. */
	public function handle_form_post(): void {
		check_admin_referer( 'tbay_subscribe', 'tbay_nonce' );

		$redirect = isset( $_POST['redirect_to'] )
			? esc_url_raw( wp_unslash( $_POST['redirect_to'] ) )
			: home_url( '/' );

		if ( ! empty( $_POST['website'] ) || ! $this->rate_limit_ok() ) {
			wp_safe_redirect( add_query_arg( 'tbay_subscribed', 'pending', $redirect ) );
			exit;
		}

		$result = $this->subscribe(
			isset( $_POST['email'] ) ? sanitize_email( wp_unslash( $_POST['email'] ) ) : '',
			isset( $_POST['name'] ) ? sanitize_text_field( wp_unslash( $_POST['name'] ) ) : '',
			isset( $_POST['list'] ) ? sanitize_key( wp_unslash( $_POST['list'] ) ) : 'newsletter',
			isset( $_POST['source'] ) ? sanitize_text_field( wp_unslash( $_POST['source'] ) ) : 'form',
			isset( $_COOKIE['tbay_visitor'] ) ? sanitize_text_field( wp_unslash( $_COOKIE['tbay_visitor'] ) ) : ''
		);

		$status = is_wp_error( $result ) ? 'error' : ( $result['status'] ?? 'pending' );
		wp_safe_redirect( add_query_arg( 'tbay_subscribed', rawurlencode( (string) $status ), $redirect ) );
		exit;
	}

	/**
	 * @return array<string,mixed>|WP_Error
	 */
	private function subscribe( string $email, string $name, string $list, string $source, string $visitor ): array|WP_Error {
		if ( ! is_email( $email ) ) {
			return new WP_Error( 'tbay_bad_email', __( 'Please enter a valid email address.', 'tbay-rewards' ) );
		}

		$body = array(
			'key'    => $this->api->public_key(),
			'email'  => $email,
			'name'   => '' !== $name ? $name : null,
			'list'   => $list,
			'source' => $source,
		);
		if ( '' !== $visitor ) {
			$body['visitor'] = $visitor;
		}

		// Uses the public ingest endpoint so a site with only a site key
		// configured can still collect signups.
		$response = wp_remote_post(
			$this->api->endpoint() . '/v1/newsletter/subscribe',
			array(
				'timeout' => 15,
				'headers' => array(
					'Content-Type' => 'application/json',
					'X-TBAY-Key'   => $this->api->public_key(),
				),
				'body'    => wp_json_encode( $body ),
			)
		);

		if ( is_wp_error( $response ) ) {
			// cURL timeouts and DNS errors are not a message for a customer.
			$this->api->log( 'Subscribe failed: ' . $response->get_error_message() );
			return new WP_Error(
				'tbay_unreachable',
				__( 'We could not reach the mailing list right now — please try again shortly.', 'tbay-rewards' )
			);
		}

		$code    = (int) wp_remote_retrieve_response_code( $response );
		$decoded = json_decode( (string) wp_remote_retrieve_body( $response ), true );
		$decoded = is_array( $decoded ) ? $decoded : array();

		if ( $code < 200 || $code >= 300 ) {
			return new WP_Error(
				'tbay_subscribe_failed',
				$decoded['message'] ?? __( 'Subscription failed. Please try again.', 'tbay-rewards' )
			);
		}

		return $decoded;
	}

	/** Five signup attempts per IP per ten minutes. */
	private function rate_limit_ok(): bool {
		$ip  = isset( $_SERVER['REMOTE_ADDR'] ) ? sanitize_text_field( wp_unslash( $_SERVER['REMOTE_ADDR'] ) ) : '';
		$key = 'tbay_sub_' . md5( $ip );

		$attempts = (int) get_transient( $key );
		if ( $attempts >= 5 ) {
			return false;
		}

		set_transient( $key, $attempts + 1, 10 * MINUTE_IN_SECONDS );
		return true;
	}
}
