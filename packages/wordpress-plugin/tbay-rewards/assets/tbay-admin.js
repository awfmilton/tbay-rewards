/**
 * TBAY Rewards — editor sidebar helper for minting writer commission links.
 */
(function () {
	'use strict';

	var config = window.tbayAdmin || {};

	document.addEventListener('DOMContentLoaded', function () {
		var button = document.getElementById('tbay-mint-link');
		var result = document.getElementById('tbay-link-result');
		var product = document.getElementById('tbay-link-product');
		if (!button || !result || !product) return;

		button.addEventListener('click', function () {
			if (!product.value) return;

			button.disabled = true;
			result.textContent = config.i18n.creating;

			var body = new URLSearchParams();
			body.append('action', 'tbay_mint_writer_link');
			body.append('nonce', config.nonce);
			body.append('post', button.dataset.post);
			body.append('product', product.value);

			fetch(config.ajaxUrl, { method: 'POST', body: body, credentials: 'same-origin' })
				.then(function (response) { return response.json(); })
				.then(function (payload) {
					if (!payload.success) throw new Error(payload.data && payload.data.message);
					result.textContent = payload.data.shortcode;

					if (navigator.clipboard) {
						navigator.clipboard.writeText(payload.data.shortcode).then(function () {
							result.textContent = payload.data.shortcode + ' — ' + config.i18n.copied;
						});
					}
				})
				['catch'](function (error) {
					result.textContent = error.message || config.i18n.failed;
				})
				['finally'](function () {
					button.disabled = false;
				});
		});
	});
}());
