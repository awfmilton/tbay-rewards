/**
 * Editor script for the TBAY newsletter block.
 *
 * Server-side `register_block_type` alone makes a block renderable but not
 * insertable — the editor needs a registration with an `edit` implementation
 * before it appears in the inserter. Written against the global `wp.*` objects
 * so it needs no build step, matching the rest of the plugin.
 */
(function (wp) {
	'use strict';

	if (!wp || !wp.blocks || !wp.element) return;

	var el = wp.element.createElement;
	var __ = wp.i18n ? wp.i18n.__ : function (text) { return text; };
	var useBlockProps = wp.blockEditor && wp.blockEditor.useBlockProps;
	var InspectorControls = wp.blockEditor && wp.blockEditor.InspectorControls;
	var PanelBody = wp.components && wp.components.PanelBody;
	var TextControl = wp.components && wp.components.TextControl;

	wp.blocks.registerBlockType('tbay/newsletter', {
		edit: function (props) {
			var attributes = props.attributes || {};
			var blockProps = useBlockProps ? useBlockProps() : {};

			function field(label, key, placeholder) {
				return el(TextControl, {
					label: label,
					value: attributes[key] || '',
					placeholder: placeholder,
					onChange: function (value) {
						var patch = {};
						patch[key] = value;
						props.setAttributes(patch);
					},
				});
			}

			var inspector = InspectorControls && PanelBody && TextControl
				? el(
						InspectorControls,
						{},
						el(
							PanelBody,
							{ title: __('Newsletter', 'tbay-rewards'), initialOpen: true },
							field(__('List', 'tbay-rewards'), 'list', 'newsletter'),
							field(__('Heading', 'tbay-rewards'), 'title', __('Join the list', 'tbay-rewards')),
							field(__('Description', 'tbay-rewards'), 'description', ''),
							field(__('Button label', 'tbay-rewards'), 'button', __('Subscribe', 'tbay-rewards'))
						)
				  )
				: null;

			// A static preview rather than a live ServerSideRender: the real form
			// posts to the platform, and nobody wants the editor doing that.
			var preview = el(
				'div',
				{
					style: {
						border: '1px solid #2c2c2e',
						borderRadius: '12px',
						padding: '20px',
						background: '#141b2d',
						color: '#e4eaf5',
						fontFamily: 'system-ui, sans-serif',
					},
				},
				el(
					'p',
					{ style: { margin: '0 0 6px', fontSize: '11px', letterSpacing: '.14em', textTransform: 'uppercase', color: '#00d4d4' } },
					__('TBAY newsletter signup', 'tbay-rewards')
				),
				el(
					'strong',
					{ style: { display: 'block', fontSize: '18px', marginBottom: '6px' } },
					attributes.title || __('Join the list', 'tbay-rewards')
				),
				el(
					'span',
					{ style: { fontSize: '13px', color: '#8896b4' } },
					attributes.description ||
						__('Double opt-in, and subscribers earn reward points.', 'tbay-rewards')
				)
			);

			return el('div', blockProps, inspector, preview);
		},

		// Rendered by PHP, so nothing is saved into post content.
		save: function () {
			return null;
		},
	});
}(window.wp));
