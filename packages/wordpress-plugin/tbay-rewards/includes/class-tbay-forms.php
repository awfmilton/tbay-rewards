<?php
/**
 * Points for form submissions.
 *
 * myCred integrates with fifteen third-party plugins; a parity review judged
 * most of them irrelevant to a WooCommerce store and singled out form
 * submissions as the exception, because the sites this ships to run Ninja
 * Forms. Gravity Forms and Contact Form 7 are here too since they cost a hook
 * each and cover most of the rest of the market.
 *
 * Three rules apply to all three integrations:
 *
 *  - **Only a signed-in customer earns.** An anonymous submission has no
 *    account to credit, and crediting by the email in the form would let
 *    anyone type someone else's address and move their balance.
 *  - **The submission id is the reference.** The platform's idempotency key is
 *    built from it, so a plugin that fires its hook twice — several do on
 *    validation retries — awards once.
 *  - **Caps are the rule's business.** A form is the cheapest thing on a site
 *    to submit, so the shipped rule carries a five-minute cooldown and a daily
 *    cap. This file does not second-guess them.
 *
 * @package TBAY_Rewards
 */

defined( 'ABSPATH' ) || exit;

class TBAY_Rewards_Forms {

	public function __construct( private TBAY_Rewards_API $api ) {
		// Ninja Forms: fires after a submission is saved and passes the whole
		// form data array, including the submission id.
		add_action( 'ninja_forms_after_submission', array( $this, 'ninja_forms' ) );

		// Gravity Forms: $entry carries the entry id and the form id.
		add_action( 'gform_after_submission', array( $this, 'gravity_forms' ), 10, 2 );

		// Contact Form 7 has no submission id of its own unless Flamingo is
		// installed, so the handler derives a stable one.
		add_action( 'wpcf7_mail_sent', array( $this, 'contact_form_7' ) );
	}

	/**
	 * @param array $data Ninja Forms submission payload.
	 */
	public function ninja_forms( $data ): void {
		if ( ! is_array( $data ) ) {
			return;
		}

		$submission_id = (string) ( $data['actions']['save']['sub_id'] ?? '' );
		$form_id       = (string) ( $data['form_id'] ?? '' );

		if ( '' === $submission_id ) {
			// No saved submission means nothing stable to key on, and a form
			// that does not save is usually a search or a filter rather than
			// something worth rewarding.
			return;
		}

		$this->award( 'nf-' . $submission_id, array( 'plugin' => 'ninja_forms', 'form_id' => $form_id ) );
	}

	/**
	 * @param array $entry Gravity Forms entry.
	 * @param array $form  Gravity Forms form definition.
	 */
	public function gravity_forms( $entry, $form ): void {
		if ( ! is_array( $entry ) ) {
			return;
		}
		$entry_id = (string) ( $entry['id'] ?? '' );
		if ( '' === $entry_id ) {
			return;
		}

		$this->award(
			'gf-' . $entry_id,
			array( 'plugin' => 'gravity_forms', 'form_id' => (string) ( $form['id'] ?? '' ) )
		);
	}

	/**
	 * @param WPCF7_ContactForm $form The submitted form.
	 */
	public function contact_form_7( $form ): void {
		if ( ! is_object( $form ) || ! method_exists( $form, 'id' ) ) {
			return;
		}

		// CF7 has no submission id unless Flamingo stores one, so build a
		// stable reference from the form, the user and the minute. Without the
		// time component a customer could only ever earn from each form once;
		// with a finer one, a double-fired hook would pay twice. A minute is
		// far shorter than the rule's five-minute cooldown, so the cooldown is
		// what actually governs the rate.
		$reference = sprintf(
			'cf7-%d-%d-%s',
			(int) $form->id(),
			get_current_user_id(),
			gmdate( 'YmdHi' )
		);

		$this->award(
			$reference,
			array( 'plugin' => 'contact_form_7', 'form_id' => (string) $form->id() )
		);
	}

	/**
	 * Fire the form_submission rule for the signed-in customer.
	 *
	 * Silent on every failure path: a form submission must succeed for the
	 * visitor whether or not the rewards platform is reachable. A points award
	 * is never worth failing somebody's contact form over.
	 */
	private function award( string $reference, array $meta ): void {
		$user_id = get_current_user_id();
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
				'ruleKey'   => 'form_submission',
				'refId'     => $reference,
				'meta'      => $meta,
			)
		);
	}
}
