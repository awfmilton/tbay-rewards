<?php
/**
 * HTTP client for the TBAY Rewards platform.
 *
 * @package TBAY_Rewards
 */

declare( strict_types = 1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Wraps every server-to-server call to the platform.
 *
 * The secret key never reaches the browser: the public site key is the only
 * credential printed into a page, and it can only write ingest data.
 */
class TBAY_Rewards_API {

	private const OPTION = 'tbay_rewards_settings';

	/** Short-lived cache so a page rendering three shortcodes makes one call. */
	private array $request_cache = array();

	public function settings(): array {
		$settings = get_option( self::OPTION, array() );
		return is_array( $settings ) ? $settings : array();
	}

	public function setting( string $key, mixed $default = '' ): mixed {
		$settings = $this->settings();
		return $settings[ $key ] ?? $default;
	}

	public function update_setting( string $key, mixed $value ): void {
		$settings         = $this->settings();
		$settings[ $key ] = $value;
		update_option( self::OPTION, $settings );
	}

	public function endpoint(): string {
		return untrailingslashit( (string) $this->setting( 'endpoint', '' ) );
	}

	public function public_key(): string {
		return (string) $this->setting( 'public_key', '' );
	}

	private function secret_key(): string {
		return (string) $this->setting( 'secret_key', '' );
	}

	public function webhook_secret(): string {
		return (string) $this->setting( 'webhook_secret', '' );
	}

	/** True when the plugin has enough configuration to talk to the platform. */
	public function is_configured(): bool {
		return '' !== $this->endpoint() && '' !== $this->secret_key();
	}

	public function is_tracking_enabled(): bool {
		return '' !== $this->endpoint() && '' !== $this->public_key() && (bool) $this->setting( 'enable_tracking', 1 );
	}

	/**
	 * Perform an authenticated request against the platform.
	 *
	 * Returns a WP_Error rather than throwing, so a platform outage degrades the
	 * storefront to "no rewards shown" instead of a fatal error on a product page.
	 *
	 * @param string $method  HTTP method.
	 * @param string $path    Path beginning with a slash.
	 * @param array  $body    Request body for write methods.
	 * @param array  $query   Query string arguments.
	 * @return array|WP_Error Decoded response body, or WP_Error on failure.
	 */
	public function request( string $method, string $path, array $body = array(), array $query = array() ): array|WP_Error {
		if ( ! $this->is_configured() ) {
			return new WP_Error( 'tbay_not_configured', __( 'TBAY Rewards is not configured yet.', 'tbay-rewards' ) );
		}

		$url = $this->endpoint() . $path;
		if ( ! empty( $query ) ) {
			$url = add_query_arg( array_filter( $query, static fn( $value ) => null !== $value && '' !== $value ), $url );
		}

		$args = array(
			'method'  => strtoupper( $method ),
			'timeout' => 15,
			'headers' => array(
				'Authorization' => 'Bearer ' . $this->secret_key(),
				'Content-Type'  => 'application/json',
				'Accept'        => 'application/json',
				'User-Agent'    => 'TBAY-Rewards-WP/' . TBAY_REWARDS_VERSION,
			),
		);

		if ( ! empty( $body ) && in_array( $args['method'], array( 'POST', 'PUT', 'PATCH' ), true ) ) {
			$args['body'] = wp_json_encode( $body );
		}

		$response = wp_remote_request( $url, $args );

		if ( is_wp_error( $response ) ) {
			$this->log( sprintf( '%s %s failed: %s', $method, $path, $response->get_error_message() ) );
			return $response;
		}

		$code    = (int) wp_remote_retrieve_response_code( $response );
		$decoded = json_decode( (string) wp_remote_retrieve_body( $response ), true );
		$decoded = is_array( $decoded ) ? $decoded : array();

		if ( $code < 200 || $code >= 300 ) {
			$message = $decoded['message'] ?? __( 'The rewards platform returned an error.', 'tbay-rewards' );
			$this->log( sprintf( '%s %s → HTTP %d: %s', $method, $path, $code, $message ) );
			return new WP_Error( 'tbay_api_error', $message, array( 'status' => $code, 'details' => $decoded['details'] ?? null ) );
		}

		return $decoded;
	}

	public function get( string $path, array $query = array() ): array|WP_Error {
		return $this->request( 'GET', $path, array(), $query );
	}

	public function post( string $path, array $body = array() ): array|WP_Error {
		return $this->request( 'POST', $path, $body );
	}

	/**
	 * GET with a short in-request cache. Report widgets on the same page render
	 * from one round trip instead of one each.
	 */
	public function get_cached( string $path, array $query = array(), int $ttl = 60 ): array|WP_Error {
		$key = md5( $path . wp_json_encode( $query ) );

		if ( isset( $this->request_cache[ $key ] ) ) {
			return $this->request_cache[ $key ];
		}

		$transient_key = 'tbay_rw_' . $key;
		$cached        = get_transient( $transient_key );
		if ( false !== $cached && is_array( $cached ) ) {
			$this->request_cache[ $key ] = $cached;
			return $cached;
		}

		$result = $this->get( $path, $query );
		if ( ! is_wp_error( $result ) ) {
			set_transient( $transient_key, $result, $ttl );
			$this->request_cache[ $key ] = $result;
		}
		return $result;
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Domain helpers
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Map a WordPress user onto a platform contact.
	 *
	 * The user id travels as `externalRef` so a customer who changes their email
	 * address stays the same contact.
	 */
	public function sync_user( int $user_id ): array|WP_Error {
		$user = get_userdata( $user_id );
		if ( ! $user ) {
			return new WP_Error( 'tbay_no_user', __( 'Unknown user.', 'tbay-rewards' ) );
		}

		$result = $this->post(
			'/v1/contacts',
			array(
				'email'       => $user->user_email,
				'name'        => trim( $user->first_name . ' ' . $user->last_name ) ?: $user->display_name,
				'externalRef' => (string) $user_id,
				'isWriter'    => user_can( $user_id, 'publish_posts' ),
			)
		);

		if ( ! is_wp_error( $result ) && isset( $result['contact_id'] ) ) {
			update_user_meta( $user_id, '_tbay_contact_id', sanitize_text_field( (string) $result['contact_id'] ) );
		}

		return $result;
	}

	/** Contact id for a user, syncing them on first use. */
	public function contact_id_for_user( int $user_id ): ?string {
		$stored = get_user_meta( $user_id, '_tbay_contact_id', true );
		if ( is_string( $stored ) && '' !== $stored ) {
			return $stored;
		}

		$result = $this->sync_user( $user_id );
		if ( is_wp_error( $result ) || empty( $result['contact_id'] ) ) {
			return null;
		}
		return (string) $result['contact_id'];
	}

	public function balance_for_user( int $user_id, int $ttl = 30 ): array|WP_Error {
		$contact_id = $this->contact_id_for_user( $user_id );
		if ( null === $contact_id ) {
			return new WP_Error( 'tbay_no_contact', __( 'No rewards account for this user yet.', 'tbay-rewards' ) );
		}
		return $this->get_cached( '/v1/rewards/balance', array( 'contactId' => $contact_id ), $ttl );
	}

	/** Badges, rank, streaks and notification count for a user. */
	public function gamification_profile( int $user_id, int $ttl = 60 ): array|WP_Error {
		$contact_id = $this->contact_id_for_user( $user_id );
		if ( null === $contact_id ) {
			return new WP_Error( 'tbay_no_contact', __( 'No rewards account for this user yet.', 'tbay-rewards' ) );
		}
		return $this->get_cached( '/v1/gamification/profile', array( 'contactId' => $contact_id ), $ttl );
	}

	/**
	 * Public chain configuration: addresses, chain ids, wallet switch params and
	 * the thirdweb client id.
	 *
	 * Fetched with the *public* site key, because everything in it is public by
	 * nature and this way it works even on a site that has only been given a
	 * site key. Cached for an hour — it changes about once per launch.
	 */
	public function chain_config(): array|WP_Error {
		if ( '' === $this->endpoint() || '' === $this->public_key() ) {
			return new WP_Error( 'tbay_not_configured', __( 'TBAY Rewards is not configured yet.', 'tbay-rewards' ) );
		}

		$cached = get_transient( 'tbay_chain_config' );
		if ( is_array( $cached ) ) {
			return $cached;
		}

		$response = wp_remote_get(
			$this->endpoint() . '/v1/config',
			array(
				'timeout' => 10,
				'headers' => array( 'X-TBAY-Key' => $this->public_key(), 'Accept' => 'application/json' ),
			)
		);
		if ( is_wp_error( $response ) ) {
			return $response;
		}

		$code    = (int) wp_remote_retrieve_response_code( $response );
		$decoded = json_decode( (string) wp_remote_retrieve_body( $response ), true );
		if ( $code < 200 || $code >= 300 || ! is_array( $decoded ) ) {
			return new WP_Error( 'tbay_config_error', __( 'Could not read the platform configuration.', 'tbay-rewards' ) );
		}

		set_transient( 'tbay_chain_config', $decoded, HOUR_IN_SECONDS );
		return $decoded;
	}

	/** Forget cached report/balance responses after something changes. */
	public function flush_cache(): void {
		global $wpdb;
		$this->request_cache = array();
		delete_transient( 'tbay_chain_config' );
		$wpdb->query(
			$wpdb->prepare(
				"DELETE FROM {$wpdb->options} WHERE option_name LIKE %s OR option_name LIKE %s",
				$wpdb->esc_like( '_transient_tbay_rw_' ) . '%',
				$wpdb->esc_like( '_transient_timeout_tbay_rw_' ) . '%'
			)
		);
	}

	public function log( string $message ): void {
		if ( defined( 'WP_DEBUG' ) && WP_DEBUG && defined( 'WP_DEBUG_LOG' ) && WP_DEBUG_LOG ) {
			// phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
			error_log( '[TBAY Rewards] ' . $message );
		}
	}
}
