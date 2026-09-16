<?php
/**
 * Plugin Name:       TBAY Rewards
 * Plugin URI:        https://github.com/awfmilton/tbay-rewards
 * Description:       Marketing automation, on-site analytics and TBAY token rewards for WordPress and WooCommerce. Tracks visitors, heatmaps, traffic sources, product engagement and abandoned carts; runs newsletter signups, blog-writer commissions and a points programme redeemable for TBAY L2 tokens.
 * Version:           1.0.0
 * Requires at least: 6.0
 * Requires PHP:      8.1
 * Author:            tbay.tk LLC
 * Author URI:        https://tbay.tk
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       tbay-rewards
 * Domain Path:       /languages
 *
 * @package TBAY_Rewards
 */

declare( strict_types = 1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'TBAY_REWARDS_VERSION', '1.0.0' );
define( 'TBAY_REWARDS_FILE', __FILE__ );
define( 'TBAY_REWARDS_DIR', plugin_dir_path( __FILE__ ) );
define( 'TBAY_REWARDS_URL', plugin_dir_url( __FILE__ ) );

require_once TBAY_REWARDS_DIR . 'includes/class-tbay-api.php';
require_once TBAY_REWARDS_DIR . 'includes/class-tbay-settings.php';
require_once TBAY_REWARDS_DIR . 'includes/class-tbay-tracker.php';
require_once TBAY_REWARDS_DIR . 'includes/class-tbay-newsletter.php';
require_once TBAY_REWARDS_DIR . 'includes/class-tbay-rewards-ui.php';
require_once TBAY_REWARDS_DIR . 'includes/class-tbay-writer-links.php';
require_once TBAY_REWARDS_DIR . 'includes/class-tbay-webhooks.php';
require_once TBAY_REWARDS_DIR . 'includes/class-tbay-admin.php';
require_once TBAY_REWARDS_DIR . 'includes/class-tbay-manage.php';
require_once TBAY_REWARDS_DIR . 'includes/class-tbay-woocommerce.php';
require_once TBAY_REWARDS_DIR . 'includes/class-tbay-mycred.php';

/**
 * Plugin bootstrap.
 *
 * Everything hangs off one instance so the pieces can find each other without
 * globals, and so a site that is not running WooCommerce simply never loads the
 * commerce half.
 */
final class TBAY_Rewards {

	private static ?TBAY_Rewards $instance = null;

	public TBAY_Rewards_API $api;
	public TBAY_Rewards_Settings $settings;
	public TBAY_Rewards_Tracker $tracker;
	public TBAY_Rewards_Newsletter $newsletter;
	public TBAY_Rewards_UI $ui;
	public TBAY_Rewards_Writer_Links $writer_links;
	public TBAY_Rewards_Webhooks $webhooks;
	public TBAY_Rewards_Admin $admin;
	private ?TBAY_Rewards_Manage $manage = null;
	public ?TBAY_Rewards_WooCommerce $woocommerce = null;
	public ?TBAY_Rewards_MyCred $mycred        = null;

	public static function instance(): TBAY_Rewards {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	private function __construct() {
		$this->api          = new TBAY_Rewards_API();
		$this->settings     = new TBAY_Rewards_Settings( $this->api );
		$this->tracker      = new TBAY_Rewards_Tracker( $this->api );
		$this->newsletter   = new TBAY_Rewards_Newsletter( $this->api );
		$this->ui           = new TBAY_Rewards_UI( $this->api );
		$this->writer_links = new TBAY_Rewards_Writer_Links( $this->api );
		$this->webhooks     = new TBAY_Rewards_Webhooks( $this->api );
		$this->admin        = new TBAY_Rewards_Admin( $this->api );
		$this->manage       = new TBAY_Rewards_Manage( $this->api );

		add_action( 'plugins_loaded', array( $this, 'load_integrations' ), 20 );
		add_action( 'init', array( $this, 'load_textdomain' ) );
	}

	/**
	 * Optional integrations load late so the plugins they depend on have
	 * definitely registered their own classes and hooks first.
	 */
	public function load_integrations(): void {
		if ( class_exists( 'WooCommerce' ) ) {
			$this->woocommerce = new TBAY_Rewards_WooCommerce( $this->api );
		}

		if ( function_exists( 'mycred' ) || class_exists( 'myCRED_Core' ) ) {
			$this->mycred = new TBAY_Rewards_MyCred( $this->api );
		}
	}

	public function load_textdomain(): void {
		load_plugin_textdomain( 'tbay-rewards', false, dirname( plugin_basename( TBAY_REWARDS_FILE ) ) . '/languages' );
	}

	/** Prevent cloning and unserialising of the singleton. */
	private function __clone() {}

	public function __wakeup(): void {
		throw new RuntimeException( 'TBAY_Rewards cannot be unserialised.' );
	}
}

/**
 * Accessor used throughout the plugin and available to themes.
 */
function tbay_rewards(): TBAY_Rewards {
	return TBAY_Rewards::instance();
}

tbay_rewards();

/**
 * Flush rewrite rules and seed defaults on activation.
 */
register_activation_hook(
	__FILE__,
	static function (): void {
		if ( false === get_option( 'tbay_rewards_settings' ) ) {
			add_option(
				'tbay_rewards_settings',
				array(
					'endpoint'          => '',
					'public_key'        => '',
					'secret_key'        => '',
					'webhook_secret'    => wp_generate_password( 40, false ),
					'enable_tracking'   => 1,
					'enable_heatmaps'   => 1,
					'require_consent'   => 0,
					'enable_commerce'   => 1,
					'enable_rewards'    => 1,
					'writer_rate_bps'   => 500,
					'mycred_point_type' => 'mycred_default',
					'mycred_sync'       => 0,
				)
			);
		}
		flush_rewrite_rules();
	}
);

register_deactivation_hook(
	__FILE__,
	static function (): void {
		wp_clear_scheduled_hook( 'tbay_rewards_sync_cart' );
		flush_rewrite_rules();
	}
);
