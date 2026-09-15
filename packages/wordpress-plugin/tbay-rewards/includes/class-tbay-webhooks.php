<?php
/**
 * Inbound webhooks from the rewards platform.
 *
 * @package TBAY_Rewards
 */

declare( strict_types = 1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Receives signed callbacks so the storefront can react to platform-side events
 * (points awarded, a claim settled, a store credit issued) without polling.
 */
class TBAY_Rewards_Webhooks {

	/** Reject a delivery whose timestamp is older than this, to stop replays. */
	private const MAX_SKEW_SECONDS = 300;

	public function __construct( private TBAY_Rewards_API $api ) {
		add_action( 'rest_api_init', array( $this, 'register_routes' ) );
	}

	public function register_routes(): void {
		register_rest_route(
			'tbay/v1',
			'/webhook',
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => array( $this, 'handle' ),
				// Authentication is the HMAC signature, checked inside the handler.
				'permission_callback' => '__return_true',
			)
		);
	}

	public function handle( WP_REST_Request $request ): WP_REST_Response {
		$secret = $this->api->webhook_secret();
		if ( '' === $secret ) {
			return new WP_REST_Response( array( 'message' => 'Webhooks are not configured.' ), 503 );
		}

		$signature = (string) $request->get_header( 'x-tbay-signature' );
		$timestamp = (string) $request->get_header( 'x-tbay-timestamp' );
		$body      = (string) $request->get_body();

		if ( ! $this->signature_valid( $signature, $timestamp, $body, $secret ) ) {
			return new WP_REST_Response( array( 'message' => 'Invalid signature.' ), 401 );
		}

		$payload = json_decode( $body, true );
		if ( ! is_array( $payload ) ) {
			return new WP_REST_Response( array( 'message' => 'Malformed payload.' ), 400 );
		}

		$topic = isset( $payload['topic'] ) ? sanitize_key( (string) $payload['topic'] ) : '';
		$data  = is_array( $payload['data'] ?? null ) ? $payload['data'] : array();

		$this->dispatch( $topic, $data );

		return new WP_REST_Response( array( 'received' => true ), 200 );
	}

	/**
	 * Verify `sha256=<hmac>` over `<timestamp>.<body>`.
	 *
	 * The timestamp is inside the signed material and checked for freshness, so
	 * a captured delivery cannot be replayed later.
	 */
	private function signature_valid( string $signature, string $timestamp, string $body, string $secret ): bool {
		if ( '' === $signature || '' === $timestamp ) {
			return false;
		}

		$age = absint( time() - (int) $timestamp );
		if ( $age > self::MAX_SKEW_SECONDS ) {
			return false;
		}

		$expected = 'sha256=' . hash_hmac( 'sha256', $timestamp . '.' . $body, $secret );
		return hash_equals( $expected, $signature );
	}

	/**
	 * @param array<string,mixed> $data Event payload.
	 */
	private function dispatch( string $topic, array $data ): void {
		// Any cached balance or report is stale the moment something changes.
		$this->api->flush_cache();

		switch ( $topic ) {
			case 'points_awarded':
			case 'points_redeemed':
				$this->sync_mycred( $data );
				break;

			case 'store_credit_issued':
				$this->offer_store_credit( $data );
				break;
		}

		/**
		 * Fires for every verified webhook from the rewards platform.
		 *
		 * @param string              $topic Event topic.
		 * @param array<string,mixed> $data  Event payload.
		 */
		do_action( 'tbay_rewards_webhook', $topic, $data );

		/**
		 * Fires for one specific verified webhook topic.
		 *
		 * @param array<string,mixed> $data Event payload.
		 */
		do_action( 'tbay_rewards_webhook_' . $topic, $data );
	}

	/**
	 * @param array<string,mixed> $data Event payload.
	 */
	private function sync_mycred( array $data ): void {
		$rewards = tbay_rewards();
		if ( null !== $rewards->mycred && isset( $data['contact_id'], $data['balance'] ) ) {
			$rewards->mycred->push_balance(
				(string) $data['contact_id'],
				(int) $data['balance']
			);
		}
	}

	/**
	 * Stage a newly issued store credit so checkout can offer it.
	 *
	 * @param array<string,mixed> $data Event payload.
	 */
	private function offer_store_credit( array $data ): void {
		if ( empty( $data['contact_id'] ) || empty( $data['code'] ) ) {
			return;
		}

		$users = get_users(
			array(
				'meta_key'   => '_tbay_contact_id',
				'meta_value' => sanitize_text_field( (string) $data['contact_id'] ),
				'number'     => 1,
				'fields'     => 'ID',
			)
		);
		if ( empty( $users ) ) {
			return;
		}

		update_user_meta(
			(int) $users[0],
			'_tbay_pending_credit',
			array(
				'code'         => sanitize_text_field( (string) $data['code'] ),
				'amount_cents' => (int) ( $data['amount_cents'] ?? 0 ),
			)
		);
	}
}
