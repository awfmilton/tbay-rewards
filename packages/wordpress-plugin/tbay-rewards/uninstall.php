<?php
/**
 * Removes the plugin's own data on uninstall.
 *
 * Deliberately conservative: the analytics, contacts, points and token records
 * live on the rewards platform and are NOT touched here. Deleting a WordPress
 * plugin must not destroy a customer's points balance or commission history.
 *
 * @package TBAY_Rewards
 */

declare( strict_types = 1 );

if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

global $wpdb;

delete_option( 'tbay_rewards_settings' );

// Cached report responses.
$wpdb->query(
	$wpdb->prepare(
		"DELETE FROM {$wpdb->options} WHERE option_name LIKE %s OR option_name LIKE %s",
		$wpdb->esc_like( '_transient_tbay_rw_' ) . '%',
		$wpdb->esc_like( '_transient_timeout_tbay_rw_' ) . '%'
	)
);

// Local pointers back to platform records. The platform keeps the records.
delete_metadata( 'user', 0, '_tbay_contact_id', '', true );
delete_metadata( 'user', 0, '_tbay_wallet', '', true );
delete_metadata( 'user', 0, '_tbay_pending_credit', '', true );
delete_metadata( 'post', 0, '_tbay_writer_links', '', true );
