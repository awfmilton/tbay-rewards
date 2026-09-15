<?php
/**
 * Front-end tracker injection.
 *
 * @package TBAY_Rewards
 */

declare( strict_types = 1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Loads the tracker script and decorates pages with the data attributes it
 * reads (product identity, share codes) so product and blog engagement is
 * captured without the theme having to call any JavaScript itself.
 */
class TBAY_Rewards_Tracker {

	public function __construct( private TBAY_Rewards_API $api ) {
		add_action( 'wp_enqueue_scripts', array( $this, 'enqueue' ) );
		add_action( 'wp_body_open', array( $this, 'render_page_context' ) );
		add_filter( 'body_class', array( $this, 'body_class' ) );
	}

	public function enqueue(): void {
		if ( ! $this->api->is_tracking_enabled() ) {
			return;
		}
		if ( is_admin() || ( function_exists( 'wp_is_json_request' ) && wp_is_json_request() ) ) {
			return;
		}

		wp_enqueue_script(
			'tbay-tracker',
			$this->api->endpoint() . '/tbay.js',
			array(),
			TBAY_REWARDS_VERSION,
			array(
				'strategy'  => 'defer',
				'in_footer' => false,
			)
		);

		// The tracker reads its configuration from its own script tag, so the
		// data-* attributes have to be added to the enqueued tag itself.
		add_filter( 'script_loader_tag', array( $this, 'add_tracker_attributes' ), 10, 3 );

		// The tbay.tk type stack. display=swap so text is never invisible while
		// the fonts load, and the components fall back to the theme's own fonts
		// if Google Fonts is blocked.
		wp_enqueue_style(
			'tbay-fonts',
			'https://fonts.googleapis.com/css2?family=Syne:wght@600;700;800&family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap',
			array(),
			null
		);

		wp_enqueue_style(
			'tbay-rewards',
			TBAY_REWARDS_URL . 'assets/tbay-rewards.css',
			array( 'tbay-fonts' ),
			TBAY_REWARDS_VERSION
		);

		wp_enqueue_script(
			'tbay-rewards',
			TBAY_REWARDS_URL . 'assets/tbay-rewards.js',
			array( 'tbay-tracker' ),
			TBAY_REWARDS_VERSION,
			true
		);

		$chain = $this->api->chain_config();

		wp_localize_script(
			'tbay-rewards',
			'tbayRewards',
			array(
				'ajaxUrl'     => admin_url( 'admin-ajax.php' ),
				'restUrl'     => esc_url_raw( rest_url( 'tbay/v1/' ) ),
				'nonce'       => wp_create_nonce( 'tbay_rewards_public' ),
				'restNonce'   => wp_create_nonce( 'wp_rest' ),
				'loggedIn'    => is_user_logged_in(),
				'endpoint'    => $this->api->endpoint(),
				'publicKey'   => $this->api->public_key(),
				'chain'       => is_wp_error( $chain ) ? null : array(
					'l2ChainId' => (int) ( $chain['token']['l2']['chainId'] ?? 0 ),
					'l2Address' => (string) ( $chain['token']['l2']['address'] ?? '' ),
					'l1Address' => (string) ( $chain['token']['l1']['address'] ?? '' ),
					'explorer'  => (string) ( $chain['token']['l2']['chain']['explorerUrl'] ?? '' ),
					'testnet'   => (bool) ( $chain['token']['l2']['chain']['testnet'] ?? false ),
					// Handed straight to wallet_addEthereumChain if the wallet has
					// never seen zkSync before.
					'addParams' => $chain['token']['l2']['addChainParams'] ?? null,
				),
				'thirdweb'    => is_wp_error( $chain ) ? null : array(
					'clientId'  => (string) ( $chain['thirdweb']['clientId'] ?? '' ),
					'chainSlug' => (string) ( $chain['thirdweb']['chainSlug'] ?? '' ),
				),
				'i18n'        => array(
					'shareCopied'   => __( 'Link copied — share it to earn points.', 'tbay-rewards' ),
					'shareFailed'   => __( 'Could not create your share link. Please try again.', 'tbay-rewards' ),
					'subscribing'   => __( 'Subscribing…', 'tbay-rewards' ),
					'subscribed'    => __( 'Almost there — check your inbox to confirm.', 'tbay-rewards' ),
					'alreadyMember' => __( 'You are already subscribed.', 'tbay-rewards' ),
					'genericError'  => __( 'Something went wrong. Please try again.', 'tbay-rewards' ),
					'connecting'    => __( 'Connecting wallet…', 'tbay-rewards' ),
					'noWallet'      => __( 'No Ethereum wallet detected. Install MetaMask to continue.', 'tbay-rewards' ),
					'redeeming'     => __( 'Preparing your claim…', 'tbay-rewards' ),
					'confirmWallet' => __( 'Confirm the transaction in your wallet.', 'tbay-rewards' ),
					'claimed'       => __( 'Claimed. Your TBAY is on its way.', 'tbay-rewards' ),
					'bridgeAmount'  => __( 'Enter how much TBAY to bridge.', 'tbay-rewards' ),
					'bridgeConnect' => __( 'Connect your wallet before bridging.', 'tbay-rewards' ),
					'bridgePreparing' => __( 'Working out what will cross…', 'tbay-rewards' ),
					'bridgeVerifying' => __( 'Verifying your burn on-chain…', 'tbay-rewards' ),
					'bridgeQueued'  => __( 'Burn verified. Your L1 release is queued.', 'tbay-rewards' ),
					'bridgeCrossing' => __( 'Burning on zkSync', 'tbay-rewards' ),
					'bridgeReceiveL1' => __( 'You receive on Ethereum', 'tbay-rewards' ),
					'bridgeWrongWallet' => __( 'Your wallet is on a different account than the one connected here. Reconnect and try again.', 'tbay-rewards' ),
					'couponChecking' => __( 'Checking your code…', 'tbay-rewards' ),
					/* translators: %d: number of points credited. */
					'couponRedeemed' => __( 'Code accepted — %d points added.', 'tbay-rewards' ),
					'transferInvalid' => __( 'Enter a recipient and how many points to send.', 'tbay-rewards' ),
					'transferSending' => __( 'Sending points…', 'tbay-rewards' ),
					/* translators: %d: number of points sent. */
					'transferSent'   => __( '%d points sent.', 'tbay-rewards' ),
				),
			)
		);
	}

	/**
	 * Attach the tracker's configuration attributes to its script tag.
	 *
	 * @param string $tag    Full script tag markup.
	 * @param string $handle Script handle.
	 * @param string $src    Script source URL.
	 */
	public function add_tracker_attributes( string $tag, string $handle, string $src ): string {
		if ( 'tbay-tracker' !== $handle ) {
			return $tag;
		}

		$attributes = array(
			'data-key'             => $this->api->public_key(),
			'data-endpoint'        => $this->api->endpoint(),
			'data-heatmap'         => $this->api->setting( 'enable_heatmaps', 1 ) ? 'true' : 'false',
			'data-require-consent' => $this->api->setting( 'require_consent', 0 ) ? 'true' : 'false',
		);

		$rendered = '';
		foreach ( $attributes as $name => $value ) {
			$rendered .= sprintf( ' %s="%s"', esc_attr( $name ), esc_attr( (string) $value ) );
		}

		return str_replace( ' src=', $rendered . ' src=', $tag );
	}

	/**
	 * Emit the page's product identity for the tracker to pick up.
	 *
	 * A hidden element rather than an inline script: it survives aggressive
	 * page caching and needs no nonce.
	 */
	public function render_page_context(): void {
		if ( ! $this->api->is_tracking_enabled() ) {
			return;
		}

		if ( function_exists( 'is_product' ) && is_product() ) {
			global $product;
			if ( ! $product instanceof WC_Product ) {
				$product = wc_get_product( get_the_ID() );
			}
			if ( $product instanceof WC_Product ) {
				printf(
					'<div hidden data-tbay-product-page="%s" data-tbay-product-name="%s" data-tbay-product-price="%s" data-tbay-product-image="%s"></div>',
					esc_attr( (string) $product->get_id() ),
					esc_attr( $product->get_name() ),
					esc_attr( (string) (int) round( (float) $product->get_price() * 100 ) ),
					esc_attr( (string) wp_get_attachment_image_url( $product->get_image_id(), 'medium' ) )
				);
			}
		}
	}

	/**
	 * @param string[] $classes Existing body classes.
	 * @return string[]
	 */
	public function body_class( array $classes ): array {
		if ( $this->api->is_tracking_enabled() ) {
			$classes[] = 'tbay-rewards-active';
		}
		return $classes;
	}
}
