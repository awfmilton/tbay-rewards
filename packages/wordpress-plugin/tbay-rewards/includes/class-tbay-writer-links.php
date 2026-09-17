<?php
/**
 * Blog-writer commission links.
 *
 * @package TBAY_Rewards
 */

declare( strict_types = 1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Lets an author drop a tracked product link into a post and earn commission on
 * what it sells.
 *
 * Links are minted once per (post, product) pair and cached in post meta, so
 * rendering a post never waits on the platform.
 */
class TBAY_Rewards_Writer_Links {

	private const META_LINKS = '_tbay_writer_links';

	public function __construct( private TBAY_Rewards_API $api ) {
		add_shortcode( 'tbay_link', array( $this, 'render_shortcode' ) );
		add_shortcode( 'tbay_my_commissions', array( $this, 'render_commissions' ) );
		add_action( 'add_meta_boxes', array( $this, 'add_meta_box' ) );
		add_action( 'wp_ajax_tbay_mint_writer_link', array( $this, 'ajax_mint_link' ) );
		add_action( 'admin_enqueue_scripts', array( $this, 'enqueue_admin' ) );
	}

	/**
	 * [tbay_link product="123"]Red Ensign[/tbay_link]
	 *
	 * @param array<string,string>|string $atts    Shortcode attributes.
	 * @param string|null                 $content Inner text.
	 */
	public function render_shortcode( $atts = array(), ?string $content = null ): string {
		$atts = shortcode_atts(
			array(
				'product' => '',
				'url'     => '',
				'class'   => 'tbay-writer-link',
				'rel'     => 'sponsored',
			),
			is_array( $atts ) ? $atts : array(),
			'tbay_link'
		);

		$post_id = get_the_ID();
		if ( ! $post_id ) {
			return (string) $content;
		}

		// `url` comes from shortcode text, which a Contributor can put in a draft
		// and see rendered in preview. A tracked link becomes a `/r/<code>`
		// redirect on the rewards domain, so an off-site destination would make
		// that domain a redirector to anywhere; those are linked plainly.
		$target = '' !== $atts['url']
			? $this->own_url( $atts['url'] )
			: ( '' !== $atts['product'] ? (string) get_permalink( (int) $atts['product'] ) : '' );

		if ( '' === $target ) {
			return (string) $content;
		}

		$link = $this->link_for( (int) $post_id, $atts['product'], $target );
		if ( null === $link ) {
			// Platform unreachable: still link to the product, just untracked.
			return sprintf(
				'<a href="%s" class="%s">%s</a>',
				esc_url( $target ),
				esc_attr( $atts['class'] ),
				wp_kses_post( (string) $content )
			);
		}

		return sprintf(
			'<a href="%s" class="%s" rel="%s" data-tbay-link="%s">%s</a>',
			esc_url( $link['url'] ),
			esc_attr( $atts['class'] ),
			esc_attr( $atts['rel'] ),
			esc_attr( $link['code'] ),
			wp_kses_post( (string) $content )
		);
	}

	/**
	 * Fetch (or mint) the tracked link for a post/product pair.
	 *
	 * @return array{code:string,url:string}|null
	 */
	private function link_for( int $post_id, string $product_ref, string $target ): ?array {
		$links = get_post_meta( $post_id, self::META_LINKS, true );
		$links = is_array( $links ) ? $links : array();
		$key   = '' !== $product_ref ? 'product-' . $product_ref : 'url-' . md5( $target );

		if ( isset( $links[ $key ]['code'], $links[ $key ]['url'] ) ) {
			return $links[ $key ];
		}

		$author_id = (int) get_post_field( 'post_author', $post_id );
		$contact_id = $author_id > 0 ? $this->api->contact_id_for_user( $author_id ) : null;
		if ( null === $contact_id ) {
			return null;
		}

		$result = $this->api->post(
			'/v1/links',
			array(
				'targetUrl'         => $target,
				'kind'              => 'writer',
				'ownerContactId'    => $contact_id,
				'productRef'        => '' !== $product_ref ? $product_ref : null,
				'postRef'           => (string) $post_id,
				'label'             => get_the_title( $post_id ),
				'commissionRateBps' => (int) $this->api->setting( 'writer_rate_bps', 500 ),
			)
		);

		if ( is_wp_error( $result ) || empty( $result['code'] ) || empty( $result['url'] ) ) {
			return null;
		}

		$links[ $key ] = array(
			'code' => (string) $result['code'],
			'url'  => (string) $result['url'],
		);
		update_post_meta( $post_id, self::META_LINKS, $links );

		return $links[ $key ];
	}

	/**
	 * A writer's own earnings.
	 *
	 * Commissions accrued on the platform but there was no way for a writer to
	 * see them from WordPress, which makes the whole arrangement hard to trust.
	 */
	public function render_commissions(): string {
		if ( ! is_user_logged_in() ) {
			return sprintf(
				'<div class="tbay-root"><p class="tbay-notice">%s</p></div>',
				esc_html__( 'Log in to see what your links have earned.', 'tbay-rewards' )
			);
		}

		$contact_id = $this->api->contact_id_for_user( get_current_user_id() );
		if ( null === $contact_id ) {
			return '';
		}

		$report = $this->api->get_cached(
			'/v1/commissions',
			array( 'contactId' => $contact_id ),
			120
		);
		if ( is_wp_error( $report ) ) {
			return sprintf(
				'<div class="tbay-root"><p class="tbay-notice">%s</p></div>',
				esc_html__( 'Your earnings are unavailable right now. Please try again shortly.', 'tbay-rewards' )
			);
		}

		$summary     = is_array( $report['summary'] ?? null ) ? $report['summary'] : array();
		$commissions = is_array( $report['commissions'] ?? null ) ? $report['commissions'] : array();

		$links = $this->api->get_cached(
			'/v1/links/report',
			array( 'ownerContactId' => $contact_id ),
			120
		);
		$rows = is_wp_error( $links ) ? array() : ( $links['links'] ?? array() );

		ob_start();
		?>
		<div class="tbay-root tbay-rewards">
			<div class="tbay-rewards__grid">
				<div class="tbay-stat">
					<span class="tbay-stat__label"><?php esc_html_e( 'Awaiting release', 'tbay-rewards' ); ?></span>
					<strong class="tbay-stat__value"><?php echo esc_html( $this->money( (int) ( $summary['pending_cents'] ?? 0 ) ) ); ?></strong>
					<span class="tbay-stat__sub"><?php esc_html_e( 'held until the refund window closes', 'tbay-rewards' ); ?></span>
				</div>
				<div class="tbay-stat">
					<span class="tbay-stat__label"><?php esc_html_e( 'Ready to pay', 'tbay-rewards' ); ?></span>
					<strong class="tbay-stat__value tbay-stat__value--accent"><?php echo esc_html( $this->money( (int) ( $summary['approved_cents'] ?? 0 ) ) ); ?></strong>
				</div>
				<div class="tbay-stat">
					<span class="tbay-stat__label"><?php esc_html_e( 'Paid to date', 'tbay-rewards' ); ?></span>
					<strong class="tbay-stat__value"><?php echo esc_html( $this->money( (int) ( $summary['paid_cents'] ?? 0 ) ) ); ?></strong>
					<span class="tbay-stat__sub">
						<?php
						printf(
							/* translators: %s: number of orders. */
							esc_html__( 'across %s orders', 'tbay-rewards' ),
							esc_html( number_format_i18n( (int) ( $summary['orders'] ?? 0 ) ) )
						);
						?>
					</span>
				</div>
			</div>

			<?php if ( ! empty( $rows ) ) : ?>
				<div class="tbay-panel">
					<span class="tbay-overline"><?php esc_html_e( 'Your links', 'tbay-rewards' ); ?></span>
					<div class="tbay-table-wrap">
						<table class="tbay-ledger">
							<thead>
								<tr>
									<th scope="col"><?php esc_html_e( 'Post', 'tbay-rewards' ); ?></th>
									<th scope="col" class="tbay-num"><?php esc_html_e( 'Clicks', 'tbay-rewards' ); ?></th>
									<th scope="col" class="tbay-num"><?php esc_html_e( 'Orders', 'tbay-rewards' ); ?></th>
									<th scope="col" class="tbay-num"><?php esc_html_e( 'Earned', 'tbay-rewards' ); ?></th>
								</tr>
							</thead>
							<tbody>
							<?php foreach ( $rows as $row ) : ?>
								<?php
								$post_ref = (string) ( $row['post_ref'] ?? '' );
								$title    = is_numeric( $post_ref ) ? (string) get_the_title( (int) $post_ref ) : '';
								?>
								<tr>
									<td><?php echo esc_html( '' !== $title ? $title : ( (string) ( $row['label'] ?? '—' ) ) ); ?></td>
									<td class="tbay-num"><?php echo esc_html( number_format_i18n( (int) ( $row['human_clicks'] ?? 0 ) ) ); ?></td>
									<td class="tbay-num"><?php echo esc_html( number_format_i18n( (int) ( $row['orders'] ?? 0 ) ) ); ?></td>
									<td class="tbay-num tbay-pos"><?php echo esc_html( $this->money( (int) ( $row['commission_cents'] ?? 0 ) ) ); ?></td>
								</tr>
							<?php endforeach; ?>
							</tbody>
						</table>
					</div>
				</div>
			<?php elseif ( empty( $commissions ) ) : ?>
				<p class="tbay-empty">
					<?php esc_html_e( 'No earnings yet. Add a product link to one of your posts to get started.', 'tbay-rewards' ); ?>
				</p>
			<?php endif; ?>
		</div>
		<?php
		return (string) ob_get_clean();
	}

	private function money( int $cents ): string {
		return function_exists( 'wc_price' )
			? wp_strip_all_tags( (string) wc_price( $cents / 100 ) )
			: number_format_i18n( $cents / 100, 2 );
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Editor support
	// ─────────────────────────────────────────────────────────────────────────

	public function add_meta_box(): void {
		if ( ! $this->api->is_configured() ) {
			return;
		}

		foreach ( array( 'post', 'page' ) as $screen ) {
			add_meta_box(
				'tbay-writer-links',
				__( 'TBAY commission links', 'tbay-rewards' ),
				array( $this, 'render_meta_box' ),
				$screen,
				'side',
				'default'
			);
		}
	}

	public function render_meta_box( WP_Post $post ): void {
		$links = get_post_meta( $post->ID, self::META_LINKS, true );
		$links = is_array( $links ) ? $links : array();

		wp_nonce_field( 'tbay_mint_link', 'tbay_mint_nonce' );
		?>
		<p class="description">
			<?php esc_html_e( 'Insert a tracked product link into this post. You earn commission on anything it sells.', 'tbay-rewards' ); ?>
		</p>

		<p>
			<label for="tbay-link-product"><?php esc_html_e( 'Product ID', 'tbay-rewards' ); ?></label>
			<input type="number" id="tbay-link-product" class="widefat" min="1" placeholder="123">
		</p>

		<p>
			<button type="button" class="button" id="tbay-mint-link" data-post="<?php echo esc_attr( (string) $post->ID ); ?>">
				<?php esc_html_e( 'Create link', 'tbay-rewards' ); ?>
			</button>
		</p>

		<p id="tbay-link-result" class="description" role="status" aria-live="polite"></p>

		<?php if ( ! empty( $links ) ) : ?>
			<h4><?php esc_html_e( 'Links in this post', 'tbay-rewards' ); ?></h4>
			<ul class="tbay-link-list">
				<?php foreach ( $links as $key => $link ) : ?>
					<li>
						<code><?php echo esc_html( (string) ( $link['code'] ?? '' ) ); ?></code>
						<small><?php echo esc_html( (string) $key ); ?></small>
					</li>
				<?php endforeach; ?>
			</ul>
		<?php endif; ?>
		<?php
	}

	public function enqueue_admin( string $hook ): void {
		if ( ! in_array( $hook, array( 'post.php', 'post-new.php' ), true ) ) {
			return;
		}

		wp_enqueue_script(
			'tbay-admin',
			TBAY_REWARDS_URL . 'assets/tbay-admin.js',
			array(),
			TBAY_REWARDS_VERSION,
			true
		);

		wp_localize_script(
			'tbay-admin',
			'tbayAdmin',
			array(
				'ajaxUrl' => admin_url( 'admin-ajax.php' ),
				'nonce'   => wp_create_nonce( 'tbay_mint_link' ),
				'i18n'    => array(
					'creating' => __( 'Creating…', 'tbay-rewards' ),
					'failed'   => __( 'Could not create the link.', 'tbay-rewards' ),
					'copied'   => __( 'Shortcode copied to your clipboard.', 'tbay-rewards' ),
				),
			)
		);
	}

	/** Mint a link from the editor sidebar. */
	/**
	 * A URL on this site, or an empty string.
	 *
	 * The destination of a tracked link has to be a fact about this site, not
	 * something anybody who can write a shortcode chooses.
	 */
	private function own_url( string $candidate ): string {
		$url = esc_url_raw( trim( $candidate ) );
		if ( '' === $url ) {
			return '';
		}

		$host   = wp_parse_url( $url, PHP_URL_HOST );
		$home   = wp_parse_url( home_url(), PHP_URL_HOST );
		$scheme = wp_parse_url( $url, PHP_URL_SCHEME );
		if ( ! is_string( $host ) || ! is_string( $home ) ) {
			return '';
		}
		if ( ! in_array( $scheme, array( 'http', 'https' ), true ) ) {
			return '';
		}

		return strtolower( $host ) === strtolower( $home ) ? $url : '';
	}

	public function ajax_mint_link(): void {
		check_ajax_referer( 'tbay_mint_link', 'nonce' );

		$post_id = isset( $_POST['post'] ) ? absint( wp_unslash( $_POST['post'] ) ) : 0;
		if ( ! $post_id || ! current_user_can( 'edit_post', $post_id ) ) {
			wp_send_json_error( array( 'message' => __( 'You cannot edit this post.', 'tbay-rewards' ) ), 403 );
		}

		$product_id = isset( $_POST['product'] ) ? absint( wp_unslash( $_POST['product'] ) ) : 0;
		if ( ! $product_id ) {
			wp_send_json_error( array( 'message' => __( 'Enter a product ID.', 'tbay-rewards' ) ), 400 );
		}

		// Any post id, not only a product: the `edit_post` check above covers
		// the post being written, and without this a Contributor could read
		// back the title of somebody else's draft by guessing ids.
		$product = get_post( $product_id );
		if ( ! $product instanceof WP_Post || 'publish' !== $product->post_status ) {
			wp_send_json_error( array( 'message' => __( 'No published product with that ID.', 'tbay-rewards' ) ), 404 );
		}

		$target = (string) get_permalink( $product_id );
		if ( '' === $target ) {
			wp_send_json_error( array( 'message' => __( 'No product with that ID.', 'tbay-rewards' ) ), 404 );
		}

		$link = $this->link_for( $post_id, (string) $product_id, $target );
		if ( null === $link ) {
			wp_send_json_error( array( 'message' => __( 'The rewards platform could not create that link.', 'tbay-rewards' ) ), 502 );
		}

		wp_send_json_success(
			array(
				'code'      => $link['code'],
				'url'       => $link['url'],
				'shortcode' => sprintf( '[tbay_link product="%d"]%s[/tbay_link]', $product_id, get_the_title( $product_id ) ),
			)
		);
	}
}
