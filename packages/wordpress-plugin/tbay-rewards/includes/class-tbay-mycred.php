<?php
/**
 * myCred bridge.
 *
 * @package TBAY_Rewards
 */

declare( strict_types = 1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Mirrors TBAY reward points into a myCred point type.
 *
 * The platform stays the system of record — myCred becomes a read-only display
 * and badge/rank surface. Doing it the other way round would mean two ledgers
 * that can disagree about what a customer is owed, which is exactly the problem
 * the points ledger exists to prevent.
 */
class TBAY_Rewards_MyCred {

	public function __construct( private TBAY_Rewards_API $api ) {
		if ( ! $this->api->setting( 'mycred_sync', 0 ) ) {
			return;
		}

		// Earning through myCred hooks is mirrored the other way, into TBAY.
		add_action( 'mycred_add', array( $this, 'on_mycred_add' ), 20, 3 );
		add_action( 'show_user_profile', array( $this, 'render_profile_balance' ) );
		add_action( 'edit_user_profile', array( $this, 'render_profile_balance' ) );
	}

	private function point_type(): string {
		$type = (string) $this->api->setting( 'mycred_point_type', 'mycred_default' );
		return '' !== $type ? $type : 'mycred_default';
	}

	/**
	 * Set a user's myCred balance to match the platform's.
	 *
	 * Uses a delta so myCred's own log stays meaningful rather than being
	 * overwritten wholesale.
	 */
	public function push_balance( string $contact_id, int $balance ): void {
		$users = get_users(
			array(
				'meta_key'   => '_tbay_contact_id',
				'meta_value' => $contact_id,
				'number'     => 1,
				'fields'     => 'ID',
			)
		);
		if ( empty( $users ) ) {
			return;
		}

		$user_id = (int) $users[0];
		if ( ! function_exists( 'mycred' ) ) {
			return;
		}

		$mycred  = mycred( $this->point_type() );
		$current = (int) $mycred->get_users_balance( $user_id, $this->point_type() );
		$delta   = $balance - $current;

		if ( 0 === $delta ) {
			return;
		}

		// Guard against re-entering our own mycred_add listener.
		remove_action( 'mycred_add', array( $this, 'on_mycred_add' ), 20 );

		$mycred->add_creds(
			'tbay_sync',
			$user_id,
			$delta,
			__( 'TBAY Rewards balance sync', 'tbay-rewards' ),
			0,
			'',
			$this->point_type()
		);

		add_action( 'mycred_add', array( $this, 'on_mycred_add' ), 20, 3 );
	}

	/**
	 * Mirror points earned through a myCred hook into the TBAY ledger, so a site
	 * already running myCred badges keeps one true balance.
	 *
	 * @param string $reference myCred reference key.
	 * @param array  $data      myCred entry data.
	 * @param object $mycred    myCred instance.
	 */
	public function on_mycred_add( $reference, $data, $mycred ): void {
		unset( $mycred );

		if ( 'tbay_sync' === $reference ) {
			return; // Our own write coming back around.
		}

		$user_id = isset( $data['user_id'] ) ? (int) $data['user_id'] : 0;
		$amount  = isset( $data['amount'] ) ? (int) $data['amount'] : 0;
		if ( $user_id <= 0 || $amount <= 0 ) {
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
				'ruleKey'   => 'mycred_' . sanitize_key( (string) $reference ),
				// The myCred entry id keeps this idempotent across retries.
				'refId'     => (string) ( $data['entry_id'] ?? md5( wp_json_encode( $data ) ) ),
				'meta'      => array( 'mycred_reference' => (string) $reference ),
			)
		);
	}

	public function render_profile_balance( WP_User $user ): void {
		$balance = $this->api->balance_for_user( $user->ID );
		if ( is_wp_error( $balance ) ) {
			return;
		}
		?>
		<h2><?php esc_html_e( 'TBAY Rewards', 'tbay-rewards' ); ?></h2>
		<table class="form-table" role="presentation">
			<tr>
				<th><?php esc_html_e( 'Points balance', 'tbay-rewards' ); ?></th>
				<td><?php echo esc_html( number_format_i18n( (int) ( $balance['points']['balance'] ?? 0 ) ) ); ?></td>
			</tr>
			<tr>
				<th><?php esc_html_e( 'Wallet', 'tbay-rewards' ); ?></th>
				<td><code><?php echo esc_html( (string) ( $balance['wallet_address'] ?? '—' ) ); ?></code></td>
			</tr>
		</table>
		<?php
	}
}
