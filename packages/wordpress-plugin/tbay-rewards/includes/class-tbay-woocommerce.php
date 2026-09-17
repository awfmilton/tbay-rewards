<?php
/**
 * WooCommerce integration: cart sync, order push, refunds and store credit.
 *
 * @package TBAY_Rewards
 */

declare( strict_types = 1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Bridges WooCommerce to the platform.
 *
 * Carts are pushed from the browser (so an anonymous shopper is tracked too);
 * orders, refunds and store credit go server-to-server, because those move
 * money and points and must not be forgeable from a page.
 */
class TBAY_Rewards_WooCommerce {

	private const ORDER_SYNCED_META = '_tbay_synced';
	private const ORDER_LINK_META   = '_tbay_link_code';
	private const CREDIT_CENTS_META = '_tbay_credit_cents';
	private const CREDIT_META       = '_tbay_store_credit_code';

	public function __construct( private TBAY_Rewards_API $api ) {
		if ( ! $this->api->setting( 'enable_commerce', 1 ) ) {
			return;
		}

		// Cart state → platform, via the tracker, on every cart change.
		add_action( 'wp_footer', array( $this, 'push_cart_snapshot' ), 30 );

		// Capture the attribution cookie at checkout so the order carries it.
		add_action( 'woocommerce_checkout_create_order', array( $this, 'attach_attribution' ), 20, 2 );
		add_action( 'woocommerce_store_api_checkout_update_order_from_request', array( $this, 'attach_attribution_store_api' ), 20, 2 );

		// Orders are reported once they are paid, not merely created.
		add_action( 'woocommerce_order_status_processing', array( $this, 'sync_order' ), 20 );
		add_action( 'woocommerce_order_status_completed', array( $this, 'sync_order' ), 20 );
		add_action( 'woocommerce_order_status_refunded', array( $this, 'sync_refund' ), 20 );
		add_action( 'woocommerce_order_status_cancelled', array( $this, 'sync_refund' ), 20 );

		// Redeem TBAY store credit as a Woo coupon-equivalent discount.
		add_action( 'woocommerce_cart_calculate_fees', array( $this, 'apply_store_credit' ), 20 );
		// Before the order exists, so a credit that is gone stops the checkout
		// instead of discounting an order nothing pays for.
		add_action( 'woocommerce_after_checkout_validation', array( $this, 'validate_store_credit' ), 10, 2 );
		add_action( 'woocommerce_checkout_order_processed', array( $this, 'consume_store_credit' ), 20 );
		add_action( 'woocommerce_before_cart_totals', array( $this, 'render_credit_form' ) );
		add_action( 'woocommerce_review_order_before_payment', array( $this, 'render_credit_form' ) );
		add_action( 'wp_ajax_tbay_apply_credit', array( $this, 'ajax_apply_credit' ) );
		add_action( 'wp_ajax_nopriv_tbay_apply_credit', array( $this, 'ajax_apply_credit' ) );

		// The catalogue, stated by the store rather than guessed from a page.
		//
		// The tracker sends product details too, but those arrive under the
		// public site key, which is in every page's source -- so the platform
		// only lets them fill in a product nobody has seen before, never
		// restate one. This is the authoritative copy: it goes over the secret
		// key, so a price change, a rename or a re-categorisation actually
		// lands. Categories especially, because reward rules match on them.
		add_action( 'woocommerce_update_product', array( $this, 'sync_product' ), 20 );
		add_action( 'woocommerce_new_product', array( $this, 'sync_product' ), 20 );

		// Keep contact records current.
		add_action( 'user_register', array( $this, 'sync_new_user' ) );
		add_action( 'woocommerce_created_customer', array( $this, 'sync_new_user' ) );

		// Product reviews. The `review` reward rule shipped from day one and
		// nothing ever fired it, so a store that advertised points for reviews
		// awarded none. Both hooks matter: comment_post covers a review posted
		// straight through, transition_comment_status covers one held for
		// moderation and approved later.
		add_action( 'comment_post', array( $this, 'maybe_reward_review' ), 20, 3 );
		add_action( 'transition_comment_status', array( $this, 'reward_review_on_approval' ), 20, 3 );

		// Product markup the tracker reads for click attribution.
		add_action( 'woocommerce_before_shop_loop_item', array( $this, 'open_product_wrapper' ), 5 );
		add_action( 'woocommerce_after_shop_loop_item', array( $this, 'close_product_wrapper' ), 100 );
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Cart
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Hand the current cart to the tracker, which batches it with the rest of
	 * the page's events. Nothing is sent when the cart is empty and unchanged.
	 */
	public function push_cart_snapshot(): void {
		if ( ! $this->api->is_tracking_enabled() || ! function_exists( 'WC' ) ) {
			return;
		}
		$cart = WC()->cart;
		if ( ! $cart ) {
			return;
		}

		$items = array();
		foreach ( $cart->get_cart() as $item ) {
			$product = $item['data'] ?? null;
			if ( ! $product instanceof WC_Product ) {
				continue;
			}
			$items[] = array(
				'productRef' => (string) $product->get_id(),
				'name'       => $product->get_name(),
				'quantity'   => (int) $item['quantity'],
				'priceCents' => (int) round( (float) $product->get_price() * 100 ),
				'url'        => get_permalink( $product->get_id() ),
				'imageUrl'   => wp_get_attachment_image_url( $product->get_image_id(), 'thumbnail' ) ?: null,
			);
		}

		$payload = array(
			'cartToken'   => $this->cart_token(),
			'items'       => $items,
			'currency'    => get_woocommerce_currency(),
			'checkoutUrl' => wc_get_checkout_url(),
		);

		wp_print_inline_script_tag(
			sprintf(
				'window.tbay && window.tbay.cart(%s, %s, %s, %s);',
				wp_json_encode( $payload['cartToken'] ),
				wp_json_encode( $payload['items'] ),
				wp_json_encode( $payload['currency'] ),
				wp_json_encode( $payload['checkoutUrl'] )
			)
		);
	}

	/**
	 * A stable per-shopper cart id.
	 *
	 * Logged-in customers key on the user id so the same cart follows them
	 * across devices; guests fall back to the Woo session id.
	 */
	private function cart_token(): string {
		if ( is_user_logged_in() ) {
			return 'user-' . get_current_user_id();
		}
		if ( function_exists( 'WC' ) && WC()->session ) {
			$customer_id = WC()->session->get_customer_id();
			if ( is_string( $customer_id ) && '' !== $customer_id ) {
				return 'guest-' . $customer_id;
			}
		}
		// A logged-out visitor has no WordPress session token, so this used to
		// be md5('') for every one of them — one shared cart token, and every
		// guest's abandoned cart merged into one stranger's.
		$visitor = isset( $_COOKIE['tbay_visitor'] )
			? sanitize_text_field( wp_unslash( $_COOKIE['tbay_visitor'] ) )
			: '';
		if ( '' !== $visitor ) {
			return 'guest-' . md5( $visitor );
		}

		$token = (string) wp_get_session_token();
		if ( '' !== $token ) {
			return 'guest-' . md5( $token );
		}

		// Nothing identifies this browser. A per-request token means the cart
		// is not tracked, which is right: better no record than everybody's
		// record in one.
		return 'guest-' . wp_generate_uuid4();
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Attribution
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Read the signed attribution cookie the platform set on the /r/ redirect
	 * and stash the link code on the order.
	 *
	 * @param WC_Order $order Order being created.
	 * @param array    $data  Checkout data (unused).
	 */
	public function attach_attribution( $order, $data = array() ): void {
		unset( $data );
		if ( ! $order instanceof WC_Order ) {
			return;
		}

		$code = $this->attribution_code();
		if ( null !== $code ) {
			$order->update_meta_data( self::ORDER_LINK_META, $code );
		}

		$visitor = isset( $_COOKIE['tbay_visitor'] ) ? sanitize_text_field( wp_unslash( $_COOKIE['tbay_visitor'] ) ) : '';
		if ( '' !== $visitor ) {
			$order->update_meta_data( '_tbay_visitor', $visitor );
		}

		$order->update_meta_data( '_tbay_cart_token', $this->cart_token() );
	}

	/**
	 * @param WC_Order $order   Order being created.
	 * @param mixed    $request Store API request (unused).
	 */
	public function attach_attribution_store_api( $order, $request = null ): void {
		unset( $request );
		$this->attach_attribution( $order );
	}

	/**
	 * Extract the link code from the platform's signed attribution cookie.
	 *
	 * The signature is verified by the platform, not here — this only needs the
	 * code, and a forged cookie can at worst misattribute one order, which the
	 * platform's own commission rules still police.
	 */
	private function attribution_code(): ?string {
		if ( isset( $_GET['tb_ref'] ) ) {
			$from_url = sanitize_text_field( wp_unslash( $_GET['tb_ref'] ) );
			if ( '' !== $from_url ) {
				return $from_url;
			}
		}

		// Written by the tracker on THIS origin when the visitor landed from a
		// /r/ link. The platform's own signed cookie lives on the API origin and
		// is invisible here, so this is the one that actually arrives.
		if ( ! empty( $_COOKIE['tbay_ref'] ) ) {
			$from_cookie = sanitize_text_field( wp_unslash( $_COOKIE['tbay_ref'] ) );
			if ( '' !== $from_cookie && preg_match( '/^[A-Za-z0-9_-]{4,64}$/', $from_cookie ) ) {
				return $from_cookie;
			}
		}

		if ( empty( $_COOKIE['tbay_attr'] ) ) {
			return null;
		}

		$raw   = sanitize_text_field( wp_unslash( $_COOKIE['tbay_attr'] ) );
		$parts = explode( '.', $raw );
		if ( count( $parts ) < 2 ) {
			return null;
		}

		$decoded = json_decode( (string) base64_decode( strtr( $parts[0], '-_', '+/' ), true ), true );
		if ( ! is_array( $decoded ) || empty( $decoded['c'] ) ) {
			return null;
		}
		return sanitize_text_field( (string) $decoded['c'] );
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Orders
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Report a paid order to the platform.
	 *
	 * Guarded by order meta so the processing → completed transition does not
	 * report the same order twice; the platform is idempotent on order_ref too,
	 * which makes this belt and braces.
	 *
	 * @param int $order_id Order id.
	 */
	public function sync_order( int $order_id ): void {
		$order = wc_get_order( $order_id );
		if ( ! $order instanceof WC_Order ) {
			return;
		}
		if ( $order->get_meta( self::ORDER_SYNCED_META ) ) {
			return;
		}

		$items = array();
		foreach ( $order->get_items() as $item ) {
			if ( ! $item instanceof WC_Order_Item_Product ) {
				continue;
			}
			$items[] = array(
				'productRef'    => (string) $item->get_product_id(),
				'name'          => $item->get_name(),
				'quantity'      => (int) $item->get_quantity(),
				'subtotalCents' => (int) round( (float) $item->get_total() * 100 ),
			);
		}

		$customer_id = (int) $order->get_customer_id();

		$result = $this->api->post(
			'/v1/orders',
			array(
				'orderRef'      => (string) $order->get_order_number(),
				'status'        => $order->get_status(),
				'totalCents'    => (int) round( (float) $order->get_total() * 100 ),
				'subtotalCents' => (int) round( (float) $order->get_subtotal() * 100 ),
				'currency'      => $order->get_currency(),
				'items'         => $items,
				'email'         => $order->get_billing_email() ?: null,
				'name'          => trim( $order->get_billing_first_name() . ' ' . $order->get_billing_last_name() ) ?: null,
				'externalRef'   => $customer_id > 0 ? (string) $customer_id : null,
				'cartToken'     => $order->get_meta( '_tbay_cart_token' ) ?: null,
				'visitorAnonId' => $order->get_meta( '_tbay_visitor' ) ?: null,
				'linkCode'      => $order->get_meta( self::ORDER_LINK_META ) ?: null,
				'placedAt'      => $order->get_date_created() ? $order->get_date_created()->date( DATE_ATOM ) : null,
			)
		);

		if ( is_wp_error( $result ) ) {
			// Leave the guard unset so a later status change retries the report.
			$order->add_order_note(
				sprintf(
					/* translators: %s: error message from the rewards platform. */
					__( 'TBAY Rewards sync failed: %s', 'tbay-rewards' ),
					$result->get_error_message()
				)
			);
			return;
		}

		$order->update_meta_data( self::ORDER_SYNCED_META, gmdate( DATE_ATOM ) );
		$order->save();

		$points = (int) ( $result['points_awarded'] ?? 0 );
		if ( $points > 0 ) {
			$order->add_order_note(
				sprintf(
					/* translators: %d: number of reward points. */
					__( 'TBAY Rewards: %d points awarded.', 'tbay-rewards' ),
					$points
				)
			);
		}

		$this->api->flush_cache();

		/**
		 * Fires after an order has been reported to the rewards platform.
		 *
		 * @param WC_Order $order  The order.
		 * @param array    $result Platform response.
		 */
		do_action( 'tbay_rewards_order_synced', $order, $result );
	}

	/**
	 * Void commissions and claw back points when an order is refunded.
	 *
	 * @param int $order_id Order id.
	 */
	/**
	 * Push one product's details to the platform over the secret key.
	 *
	 * Runs on save rather than on a schedule: a catalogue sync that only
	 * happens nightly means a price corrected at ten in the morning is wrong
	 * on every report until the following day.
	 */
	public function sync_product( int $product_id ): void {
		$product = wc_get_product( $product_id );
		if ( ! $product instanceof WC_Product ) {
			return;
		}

		$categories = array();
		$terms      = get_the_terms( $product_id, 'product_cat' );
		if ( is_array( $terms ) ) {
			foreach ( $terms as $term ) {
				$categories[] = $term->slug;
			}
		}

		$price = $product->get_price();

		$result = $this->api->request(
			'PUT',
			'/v1/products/' . rawurlencode( (string) $product_id ),
			array(
				'name'       => $product->get_name(),
				'url'        => get_permalink( $product_id ) ?: null,
				'imageUrl'   => wp_get_attachment_image_url( $product->get_image_id(), 'thumbnail' ) ?: null,
				'priceCents' => '' === $price || null === $price ? null : (int) round( (float) $price * 100 ),
				'currency'   => get_woocommerce_currency(),
				'categories' => $categories,
			)
		);

		if ( is_wp_error( $result ) ) {
			$this->api->log( 'Product sync failed for ' . $product_id . ': ' . $result->get_error_message() );
		}
	}

	public function sync_refund( int $order_id ): void {
		$order = wc_get_order( $order_id );
		if ( ! $order instanceof WC_Order || ! $order->get_meta( self::ORDER_SYNCED_META ) ) {
			return;
		}

		$result = $this->api->post( '/v1/orders/' . rawurlencode( (string) $order->get_order_number() ) . '/refund' );
		if ( is_wp_error( $result ) ) {
			$this->api->log( 'Refund sync failed for order ' . $order_id . ': ' . $result->get_error_message() );
			return;
		}

		$order->add_order_note( __( 'TBAY Rewards: commissions voided and reward points reversed.', 'tbay-rewards' ) );
		$this->api->flush_cache();
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Store credit earned by spending TBAY
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Offer any store credit the shopper holds at cart and checkout.
	 *
	 * Without this the credit existed on the platform and the discount code was
	 * written to the session by nothing at all, so "spend TBAY at checkout" was
	 * a promise with no way to keep it.
	 */
	public function render_credit_form(): void {
		if ( ! is_user_logged_in() || ! $this->api->is_configured() ) {
			return;
		}

		$applied = function_exists( 'WC' ) && WC()->session
			? WC()->session->get( 'tbay_store_credit' )
			: null;

		if ( is_array( $applied ) && ! empty( $applied['code'] ) ) {
			printf(
				'<div class="tbay-root"><p class="tbay-notice">%s</p></div>',
				esc_html(
					sprintf(
						/* translators: %s: formatted credit amount. */
						__( 'TBAY store credit applied: %s', 'tbay-rewards' ),
						$this->format_money( (int) ( $applied['amount_cents'] ?? 0 ) )
					)
				)
			);
			return;
		}

		$balance = $this->api->balance_for_user( get_current_user_id() );
		$cents   = is_wp_error( $balance ) ? 0 : (int) ( $balance['store_credit_cents'] ?? 0 );
		if ( $cents <= 0 ) {
			return;
		}
		?>
		<div class="tbay-root" data-tbay-credit>
			<div class="tbay-panel">
				<span class="tbay-overline"><?php esc_html_e( 'TBAY store credit', 'tbay-rewards' ); ?></span>
				<p class="tbay-lede">
					<?php
					printf(
						/* translators: %s: formatted credit amount. */
						esc_html__( 'You have %s of TBAY store credit available.', 'tbay-rewards' ),
						esc_html( $this->format_money( $cents ) )
					);
					?>
				</p>
				<button type="button" class="tbay-button" data-tbay-apply-credit
					data-nonce="<?php echo esc_attr( wp_create_nonce( 'tbay_apply_credit' ) ); ?>">
					<?php esc_html_e( 'Use my credit', 'tbay-rewards' ); ?>
				</button>
				<p class="tbay-wallet__status" role="status" aria-live="polite" data-tbay-credit-status></p>
			</div>
		</div>
		<?php
	}

	/** Stage the shopper's credit on the session so the fee hook can apply it. */
	public function ajax_apply_credit(): void {
		check_ajax_referer( 'tbay_apply_credit', 'nonce' );

		if ( ! is_user_logged_in() || ! function_exists( 'WC' ) || ! WC()->session ) {
			wp_send_json_error( array( 'message' => __( 'Please log in first.', 'tbay-rewards' ) ), 403 );
		}

		$contact_id = $this->api->contact_id_for_user( get_current_user_id() );
		if ( null === $contact_id ) {
			wp_send_json_error( array( 'message' => __( 'No rewards account found.', 'tbay-rewards' ) ), 404 );
		}

		// The platform is the source of truth for which credits are still live;
		// trusting a code from the browser would let anyone apply any credit.
		$credits = $this->api->get(
			'/v1/rewards/balance',
			array( 'contactId' => $contact_id )
		);
		if ( is_wp_error( $credits ) || (int) ( $credits['store_credit_cents'] ?? 0 ) <= 0 ) {
			wp_send_json_error( array( 'message' => __( 'No credit available.', 'tbay-rewards' ) ), 422 );
		}

		$code = $this->api->post( '/v1/token/credit/reserve', array( 'contactId' => $contact_id ) );
		if ( is_wp_error( $code ) || empty( $code['code'] ) ) {
			wp_send_json_error( array( 'message' => __( 'Could not reserve your credit.', 'tbay-rewards' ) ), 502 );
		}

		WC()->session->set(
			'tbay_store_credit',
			array(
				'code'         => sanitize_text_field( (string) $code['code'] ),
				'amount_cents' => (int) $code['amount_cents'],
			)
		);

		wp_send_json_success( array( 'amount_cents' => (int) $code['amount_cents'] ) );
	}

	private function format_money( int $cents ): string {
		return function_exists( 'wc_price' )
			? wp_strip_all_tags( (string) wc_price( $cents / 100 ) )
			: number_format_i18n( $cents / 100, 2 );
	}

	/** Apply a store credit the shopper has chosen to use, as a negative fee. */
	public function apply_store_credit(): void {
		if ( ! function_exists( 'WC' ) || ! WC()->session ) {
			return;
		}

		$credit = WC()->session->get( 'tbay_store_credit' );
		if ( ! is_array( $credit ) || empty( $credit['code'] ) || empty( $credit['amount_cents'] ) ) {
			return;
		}

		$cart = WC()->cart;
		if ( ! $cart ) {
			return;
		}

		// Never discount below zero: credit beyond the basket stays on the
		// account, and now genuinely does — the platform draws the credit down
		// by what was used rather than consuming the whole code.
		$amount = min( (float) $credit['amount_cents'] / 100, (float) $cart->get_subtotal() );
		if ( $amount <= 0 ) {
			return;
		}

		$cart->add_fee( __( 'TBAY store credit', 'tbay-rewards' ), -$amount, false );
	}

	/**
	 * How many cents of credit this cart is currently discounting.
	 *
	 * Read back off the fee rather than recomputed, so the amount burned is the
	 * amount the customer was actually given.
	 */
	private function applied_credit_cents(): int {
		$cart = function_exists( 'WC' ) && WC() ? WC()->cart : null;
		if ( ! $cart ) {
			return 0;
		}

		$label = __( 'TBAY store credit', 'tbay-rewards' );
		foreach ( (array) $cart->get_fees() as $fee ) {
			if ( isset( $fee->name ) && $fee->name === $label ) {
				return (int) round( abs( (float) $fee->amount ) * 100 );
			}
		}
		return 0;
	}

	/**
	 * Refuse the checkout if the credit will not cover the discount.
	 *
	 * The discount used to be applied as a cart fee and burned only after the
	 * order had been written with it. A credit already spent in another tab, or
	 * a platform that did not answer, left the order complete and discounted
	 * with nothing burned against it — the same value given away twice.
	 *
	 * Checked here, where adding an error stops the checkout and the customer
	 * sees why.
	 *
	 * @param array    $data   Posted checkout fields.
	 * @param WP_Error $errors Errors to add to.
	 */
	public function validate_store_credit( $data, $errors ): void {
		if ( ! function_exists( 'WC' ) || ! WC()->session || ! $errors instanceof WP_Error ) {
			return;
		}

		$credit = WC()->session->get( 'tbay_store_credit' );
		if ( ! is_array( $credit ) || empty( $credit['code'] ) ) {
			return;
		}

		$wanted = $this->applied_credit_cents();
		if ( $wanted <= 0 ) {
			return;
		}

		$contact_id = $this->api->contact_id_for_user( get_current_user_id() );
		$fresh      = null === $contact_id
			? null
			: $this->api->post( '/v1/token/credit/reserve', array( 'contactId' => $contact_id ) );

		if ( is_wp_error( $fresh ) || ! is_array( $fresh ) ) {
			// The platform did not answer. Better a checkout the customer can
			// retry without the credit than an order nobody is paid for.
			$errors->add(
				'tbay_credit',
				__( 'We could not confirm your store credit just now. Please remove it and try again, or come back in a moment.', 'tbay-rewards' )
			);
			return;
		}

		$remaining = (int) ( $fresh['remaining_cents'] ?? $fresh['amount_cents'] ?? 0 );
		// `reserve` returns the oldest credit with something left, so a code
		// that no longer matches means the one in the session is spent.
		if ( (string) ( $fresh['code'] ?? '' ) !== (string) $credit['code'] || $remaining < $wanted ) {
			$errors->add(
				'tbay_credit',
				__( 'Your store credit has changed since you added it. Please refresh the checkout.', 'tbay-rewards' )
			);
		}
	}

	/**
	 * Burn the credit once the order exists, so an abandoned checkout does not
	 * consume it.
	 *
	 * @param int $order_id Order id.
	 */
	public function consume_store_credit( int $order_id ): void {
		if ( ! function_exists( 'WC' ) || ! WC()->session ) {
			return;
		}
		$credit = WC()->session->get( 'tbay_store_credit' );
		if ( ! is_array( $credit ) || empty( $credit['code'] ) ) {
			return;
		}

		$order = wc_get_order( $order_id );
		if ( ! $order instanceof WC_Order ) {
			return;
		}

		// The amount actually discounted, not the credit's face value. Burning
		// the whole code for a $10 discount on a $50 credit threw $40 of the
		// customer's money away.
		$used = (int) $order->get_meta( self::CREDIT_CENTS_META );
		if ( $used <= 0 ) {
			$used = $this->applied_credit_cents();
		}
		if ( $used <= 0 ) {
			WC()->session->set( 'tbay_store_credit', null );
			return;
		}

		$result = $this->api->post(
			'/v1/token/credit/redeem',
			array(
				'code'        => (string) $credit['code'],
				// Keyed on the order, so a retry after a timeout burns once.
				'orderRef'    => (string) $order->get_order_number(),
				'amountCents' => $used,
			)
		);

		WC()->session->set( 'tbay_store_credit', null );

		if ( is_wp_error( $result ) ) {
			// The order already carries the discount, and nothing was burned
			// against it. Held rather than left to fulfil: somebody has to
			// decide whether to honour it, and that somebody is not this hook.
			$order->add_order_note(
				sprintf(
					/* translators: 1: amount in cents, 2: error message. */
					__( 'TBAY store credit of %1$d cents could not be redeemed: %2$s. The order is on hold until this is settled.', 'tbay-rewards' ),
					$used,
					$result->get_error_message()
				)
			);
			$order->update_status( 'on-hold' );
			return;
		}

		$order->update_meta_data( self::CREDIT_META, (string) $credit['code'] );
		$order->update_meta_data( self::CREDIT_CENTS_META, $used );
		$order->save();
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Misc
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * @param int $user_id New user id.
	 */
	public function sync_new_user( int $user_id ): void {
		$this->api->sync_user( $user_id );
	}

	/**
	 * Award review points when a review is posted already approved.
	 *
	 * @param int        $comment_id  The new comment.
	 * @param int|string $approved    1, 0 or 'spam'.
	 * @param array      $commentdata Raw comment data.
	 */
	public function maybe_reward_review( int $comment_id, $approved, array $commentdata ): void {
		if ( 1 !== (int) $approved ) {
			return; // Held for moderation; the transition hook picks it up.
		}
		$this->reward_review( $comment_id );
	}

	/**
	 * Award review points when a held review is approved.
	 *
	 * @param string     $new_status New comment status.
	 * @param string     $old_status Previous comment status.
	 * @param WP_Comment $comment    The comment.
	 */
	public function reward_review_on_approval( $new_status, $old_status, $comment ): void {
		if ( 'approved' !== $new_status || 'approved' === $old_status ) {
			return;
		}
		if ( ! $comment instanceof WP_Comment ) {
			return;
		}
		$this->reward_review( (int) $comment->comment_ID );
	}

	/**
	 * Fire the `review` rule for one approved product review.
	 *
	 * Only genuine product reviews count — a blog comment is not a review —
	 * and only from a logged-in customer, because an anonymous review has no
	 * account to credit. The comment id is the reference, so the platform's
	 * idempotency key makes an approve/unapprove/re-approve cycle award once.
	 * Caps and cooldowns are the rule's business, not this hook's.
	 */
	private function reward_review( int $comment_id ): void {
		$comment = get_comment( $comment_id );
		if ( ! $comment instanceof WP_Comment ) {
			return;
		}

		// WooCommerce stores reviews as comments on a product post.
		if ( 'review' !== $comment->comment_type && 'product' !== get_post_type( $comment->comment_post_ID ) ) {
			return;
		}

		// A reply to a review is not a review.
		if ( (int) $comment->comment_parent > 0 ) {
			return;
		}

		$user_id = (int) $comment->user_id;
		if ( $user_id <= 0 ) {
			return;
		}

		$contact_id = $this->api->contact_id_for_user( $user_id );
		if ( null === $contact_id ) {
			return;
		}

		$this->api->post(
			'/v1/rewards/trigger',
			array(
				'contactId' => $contact_id,
				'ruleKey'   => 'review',
				'refId'     => 'review-' . $comment_id,
				'meta'      => array(
					'comment_id' => $comment_id,
					'product_id' => (int) $comment->comment_post_ID,
					'rating'     => (int) get_comment_meta( $comment_id, 'rating', true ),
				),
			)
		);
	}

	public function open_product_wrapper(): void {
		global $product;
		if ( $product instanceof WC_Product ) {
			printf( '<div data-tbay-product="%s" class="tbay-product-tile">', esc_attr( (string) $product->get_id() ) );
		}
	}

	public function close_product_wrapper(): void {
		global $product;
		if ( $product instanceof WC_Product ) {
			echo '</div>';
		}
	}
}
