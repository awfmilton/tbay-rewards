/**
 * The email builder.
 *
 * A list of typed blocks with typed fields, and the server renders the HTML.
 * Nothing here composes markup for the message — it composes JSON — which is
 * the point: an HTML textarea in wp-admin is a stored XSS vector against the
 * next admin who opens the preview, and a list of escaped field values is not.
 *
 * The block catalogue comes from the API (`GET /v1/email/blocks`) rather than
 * being written out here. A hard-coded copy is a second schema: add a field
 * server-side and this file silently drops it, which looks like the block "not
 * saving" and fails nowhere anybody is looking.
 */
( function () {
	'use strict';

	var config = window.tbayBuilder;
	if ( ! config ) {
		return;
	}

	var root = document.getElementById( 'tbay-builder' );
	var field = document.getElementById( 'tbay-blocks' );
	if ( ! root || ! field ) {
		return;
	}

	var catalogue = Array.isArray( config.catalogue ) ? config.catalogue : [];
	var blocks = Array.isArray( config.value ) ? config.value : [];
	var strings = config.strings || {};

	function say( key, fallback ) {
		return strings[ key ] || fallback;
	}

	function specFor( type ) {
		for ( var i = 0; i < catalogue.length; i += 1 ) {
			if ( catalogue[ i ].type === type ) {
				return catalogue[ i ];
			}
		}
		return null;
	}

	function el( tag, attrs, text ) {
		var node = document.createElement( tag );
		Object.keys( attrs || {} ).forEach( function ( name ) {
			if ( name === 'class' ) {
				node.className = attrs[ name ];
			} else {
				node.setAttribute( name, attrs[ name ] );
			}
		} );
		if ( text !== undefined && text !== null ) {
			node.textContent = String( text );
		}
		return node;
	}

	/** Write the current blocks back into the form's hidden input. */
	function sync() {
		field.value = JSON.stringify( blocks );
	}

	function fieldControl( spec, value, onChange ) {
		var control;

		if ( spec.kind === 'longtext' ) {
			control = el( 'textarea', { rows: '5', class: 'large-text' } );
			control.value = value === undefined || value === null ? '' : String( value );
		} else if ( spec.kind === 'choice' ) {
			control = el( 'select', {} );
			( spec.choices || [] ).forEach( function ( choice ) {
				var option = el( 'option', { value: choice.value }, choice.label );
				control.appendChild( option );
			} );
			control.value = value === undefined || value === null ? '' : String( value );
		} else {
			control = el( 'input', {
				type: spec.kind === 'url' ? 'text' : 'text',
				class: 'regular-text',
			} );
			if ( spec.max ) {
				control.setAttribute( 'maxlength', String( spec.max ) );
			}
			control.value = value === undefined || value === null ? '' : String( value );
		}

		control.addEventListener( 'input', function () {
			onChange( control.value );
		} );
		control.addEventListener( 'change', function () {
			onChange( control.value );
		} );
		return control;
	}

	/** One field row: label, control, and the hint if the field has one. */
	function fieldRow( spec, value, onChange ) {
		var wrap = el( 'p', { class: 'tbay-builder-field' } );
		var label = el( 'label', {} );
		label.appendChild(
			el( 'span', { class: 'tbay-builder-label' }, spec.label + ( spec.required ? ' *' : '' ) )
		);
		label.appendChild( fieldControl( spec, value, onChange ) );
		wrap.appendChild( label );
		if ( spec.hint ) {
			wrap.appendChild( el( 'span', { class: 'description' }, spec.hint ) );
		}
		return wrap;
	}

	/** A repeating field, such as the products in a product block. */
	function listField( spec, block, render ) {
		var wrap = el( 'div', { class: 'tbay-builder-list' } );
		wrap.appendChild( el( 'strong', {}, spec.label ) );

		var rows = Array.isArray( block[ spec.name ] ) ? block[ spec.name ] : [];
		block[ spec.name ] = rows;

		rows.forEach( function ( row, index ) {
			var card = el( 'div', { class: 'tbay-builder-list-row' } );
			( spec.fields || [] ).forEach( function ( sub ) {
				card.appendChild(
					fieldRow( sub, row[ sub.name ], function ( next ) {
						if ( next === '' ) {
							delete row[ sub.name ];
						} else {
							row[ sub.name ] = next;
						}
						sync();
					} )
				);
			} );

			var remove = el( 'button', { type: 'button', class: 'button-link delete' }, say( 'removeRow', 'Remove' ) );
			remove.addEventListener( 'click', function () {
				rows.splice( index, 1 );
				sync();
				render();
			} );
			card.appendChild( remove );
			wrap.appendChild( card );
		} );

		if ( ! spec.maxItems || rows.length < spec.maxItems ) {
			var add = el( 'button', { type: 'button', class: 'button' }, say( 'addRow', 'Add another' ) );
			add.addEventListener( 'click', function () {
				rows.push( {} );
				sync();
				render();
			} );
			wrap.appendChild( add );
		}

		return wrap;
	}

	function blockCard( block, index, render ) {
		var spec = specFor( block.type );
		var card = el( 'div', { class: 'tbay-builder-block' } );

		var head = el( 'div', { class: 'tbay-builder-head' } );
		head.appendChild( el( 'strong', {}, spec ? spec.label : block.type ) );

		var tools = el( 'div', { class: 'tbay-builder-tools' } );
		[
			[ '↑', say( 'moveUp', 'Move up' ), index > 0, -1 ],
			[ '↓', say( 'moveDown', 'Move down' ), index < blocks.length - 1, 1 ],
		].forEach( function ( move ) {
			var button = el( 'button', { type: 'button', class: 'button', title: move[ 1 ] }, move[ 0 ] );
			button.setAttribute( 'aria-label', move[ 1 ] );
			if ( ! move[ 2 ] ) {
				button.disabled = true;
			}
			button.addEventListener( 'click', function () {
				var to = index + move[ 3 ];
				var moved = blocks.splice( index, 1 )[ 0 ];
				blocks.splice( to, 0, moved );
				sync();
				render();
			} );
			tools.appendChild( button );
		} );

		var remove = el( 'button', { type: 'button', class: 'button-link delete' }, say( 'removeBlock', 'Remove' ) );
		remove.addEventListener( 'click', function () {
			blocks.splice( index, 1 );
			sync();
			render();
		} );
		tools.appendChild( remove );
		head.appendChild( tools );
		card.appendChild( head );

		if ( spec && spec.summary ) {
			card.appendChild( el( 'p', { class: 'description' }, spec.summary ) );
		}

		( spec ? spec.fields : [] ).forEach( function ( fieldSpec ) {
			if ( fieldSpec.kind === 'list' ) {
				card.appendChild( listField( fieldSpec, block, render ) );
				return;
			}
			card.appendChild(
				fieldRow( fieldSpec, block[ fieldSpec.name ], function ( next ) {
					if ( next === '' ) {
						delete block[ fieldSpec.name ];
					} else {
						block[ fieldSpec.name ] = next;
					}
					sync();
				} )
			);
		} );

		return card;
	}

	function render() {
		root.innerHTML = '';

		if ( blocks.length === 0 ) {
			root.appendChild(
				el( 'p', { class: 'description' }, say( 'empty', 'No blocks yet. Add one below.' ) )
			);
		}

		blocks.forEach( function ( block, index ) {
			root.appendChild( blockCard( block, index, render ) );
		} );

		var adder = el( 'div', { class: 'tbay-builder-add' } );
		var picker = el( 'select', { 'aria-label': say( 'addBlock', 'Add a block' ) } );
		catalogue.forEach( function ( spec ) {
			picker.appendChild( el( 'option', { value: spec.type }, spec.label ) );
		} );
		adder.appendChild( picker );

		var add = el( 'button', { type: 'button', class: 'button' }, say( 'addBlock', 'Add a block' ) );
		add.addEventListener( 'click', function () {
			blocks.push( { type: picker.value } );
			sync();
			render();
		} );
		adder.appendChild( add );

		if ( config.preview ) {
			var preview = el( 'button', { type: 'button', class: 'button' }, say( 'preview', 'Preview' ) );
			preview.addEventListener( 'click', function () {
				showPreview( preview );
			} );
			adder.appendChild( preview );
		}

		root.appendChild( adder );
		sync();
	}

	/**
	 * Ask the server what this will look like.
	 *
	 * Rendered server-side and shown in a sandboxed iframe: the preview is the
	 * real message, and the real message is HTML this page must not execute in
	 * the admin's own session.
	 */
	function showPreview( button ) {
		var pane = document.getElementById( 'tbay-builder-preview' );
		if ( ! pane ) {
			return;
		}
		var asInput = document.getElementById( 'tbay-preview-as' );
		var body = new window.FormData();
		body.append( 'action', config.preview.action );
		body.append( '_wpnonce', config.preview.nonce );
		body.append( 'blocks', JSON.stringify( blocks ) );
		body.append( 'subject', ( document.getElementById( 'tbay-subject' ) || {} ).value || '' );
		body.append( 'preheader', ( document.getElementById( 'tbay-preheader' ) || {} ).value || '' );
		if ( asInput && asInput.value ) {
			body.append( 'as', asInput.value );
		}

		button.disabled = true;
		pane.textContent = say( 'loading', 'Rendering…' );

		window
			.fetch( config.preview.url, { method: 'POST', credentials: 'same-origin', body: body } )
			.then( function ( response ) {
				return response.json();
			} )
			.then( function ( result ) {
				pane.innerHTML = '';
				if ( ! result || ! result.success ) {
					pane.appendChild(
						el(
							'p',
							{ class: 'notice notice-error' },
							( result && result.data && result.data.message ) ||
								say( 'previewFailed', 'That preview could not be rendered.' )
						)
					);
					return;
				}

				var matched = result.data.segments_matched || [];
				var used = result.data.segments_used || [];
				if ( used.length ) {
					pane.appendChild(
						el(
							'p',
							{ class: 'description' },
							say( 'conditional', 'Conditional blocks in this message:' ) +
								' ' +
								used.join( ', ' ) +
								' — ' +
								say( 'matching', 'this person is in:' ) +
								' ' +
								( matched.length ? matched.join( ', ' ) : say( 'none', 'none' ) )
						)
					);
				}

				var frame = el( 'iframe', {
					class: 'tbay-builder-frame',
					sandbox: '',
					title: say( 'preview', 'Preview' ),
				} );
				frame.setAttribute( 'srcdoc', result.data.html );
				pane.appendChild( frame );
			} )
			.catch( function () {
				pane.textContent = say( 'previewFailed', 'That preview could not be rendered.' );
			} )
			.then( function () {
				button.disabled = false;
			} );
	}

	render();
} )();
