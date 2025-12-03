/**
 * Tree serialization for LLM output
 * Converts processed DOM tree to browser-use format string
 */

import type { RawDOMNode, LLMTreeResult, GetLLMTreeOptions, ProcessedNode } from './types.js';
import { DEFAULT_INCLUDE_ATTRIBUTES } from './types.js';
import { isInteractive } from './interactive.js';
import { isVisible } from './visibility.js';

/**
 * Context for serialization - tracks state across recursive calls
 */
interface SerializationContext {
	index: number;
	selectorMap: Map<number, string>;
	previousState?: Map<number, boolean>;
	maxTextLength: number;
	includeAttributes: string[];
}

/**
 * Build a CSS selector for a node
 * Prefers: id > data-testid > unique attributes > nth-child path
 */
export function buildSelector(node: RawDOMNode, ancestors: RawDOMNode[] = []): string {
	const tagName = node.tagName.toLowerCase();

	// Skip pseudo-elements and text nodes
	if (tagName.startsWith('#') || node.nodeType === 'TEXT_NODE') {
		return '';
	}

	// Prefer ID selector
	if (node.attributes.id) {
		return `#${escapeSelector(node.attributes.id)}`;
	}

	// Use data-testid if available
	if (node.attributes['data-testid']) {
		return `[data-testid="${escapeSelector(node.attributes['data-testid'])}"]`;
	}

	// Use name attribute for form elements
	if (node.attributes.name && ['input', 'select', 'textarea'].includes(tagName)) {
		return `${tagName}[name="${escapeSelector(node.attributes.name)}"]`;
	}

	// Build path using nth-child from root
	const pathParts: string[] = [];
	const path = [...ancestors, node];

	for (let i = 0; i < path.length; i++) {
		const current = path[i];
		const currentTag = current.tagName.toLowerCase();

		if (currentTag.startsWith('#') || current.nodeType === 'TEXT_NODE') {
			continue;
		}

		if (current.attributes.id) {
			pathParts.length = 0; // Reset path, start from id
			pathParts.push(`#${escapeSelector(current.attributes.id)}`);
		} else if (i > 0) {
			const parent = path[i - 1];
			const sameTagSiblings = parent.children.filter((c) => c.tagName.toLowerCase() === currentTag);

			if (sameTagSiblings.length === 1) {
				pathParts.push(currentTag);
			} else {
				const index = sameTagSiblings.findIndex((c) => c.nodeId === current.nodeId);
				pathParts.push(`${currentTag}:nth-of-type(${index + 1})`);
			}
		} else {
			pathParts.push(currentTag);
		}
	}

	return pathParts.join(' > ');
}

/**
 * Escape special characters in CSS selector values
 */
function escapeSelector(value: string): string {
	return value.replace(/([!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1');
}

/**
 * Build attribute string for a node
 */
export function buildAttributeString(
	node: RawDOMNode,
	includeAttributes: string[] = DEFAULT_INCLUDE_ATTRIBUTES
): string {
	const attrs: string[] = [];
	const seenValues = new Set<string>();

	for (const attrName of includeAttributes) {
		const value = node.attributes[attrName];

		if (value === undefined || value === '') {
			continue;
		}

		// Skip duplicate values (deduplication)
		if (seenValues.has(value)) {
			continue;
		}
		seenValues.add(value);

		// Format attribute
		if (value === '' || value === attrName) {
			// Boolean attribute
			attrs.push(attrName);
		} else {
			attrs.push(`${attrName}="${escapeAttribute(value)}"`);
		}
	}

	return attrs.join(' ');
}

/**
 * Escape special characters in attribute values
 */
function escapeAttribute(value: string): string {
	return value.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Truncate text content to max length
 */
export function truncateText(text: string, maxLength: number): string {
	const cleaned = text.trim().replace(/\s+/g, ' ');

	if (cleaned.length <= maxLength) {
		return cleaned;
	}

	return cleaned.substring(0, maxLength - 3) + '...';
}

/**
 * Get scroll info string for scrollable containers
 */
export function getScrollInfo(node: RawDOMNode): string {
	if (!node.isScrollable || node.clientHeight === 0) {
		return '';
	}

	const totalScrollableHeight = node.scrollHeight;
	const viewportHeight = node.clientHeight;
	const currentScrollTop = node.scrollTop;

	if (totalScrollableHeight <= viewportHeight) {
		return '';
	}

	const pagesAbove = currentScrollTop / viewportHeight;
	const pagesBelow = (totalScrollableHeight - currentScrollTop - viewportHeight) / viewportHeight;

	return `(${pagesAbove.toFixed(1)} pages above, ${pagesBelow.toFixed(1)} pages below)`;
}

/**
 * Serialize a single node to string format
 */
function serializeNode(
	node: RawDOMNode,
	depth: number,
	ctx: SerializationContext,
	ancestors: RawDOMNode[]
): string {
	const indent = '\t'.repeat(depth);
	const tagName = node.tagName.toLowerCase();
	const lines: string[] = [];

	// Skip text nodes - their content is handled by the parent
	if (node.nodeType === 'TEXT_NODE' || tagName === '#text') {
		return '';
	}

	// Skip non-visible elements
	if (!isVisible(node)) {
		return '';
	}

	// Handle shadow roots
	if (node.nodeType === 'DOCUMENT_FRAGMENT_NODE') {
		const shadowMarker = `|SHADOW(${node.shadowMode || 'open'})|`;
		lines.push(`${indent}${shadowMarker}`);

		for (const child of node.children) {
			const childOutput = serializeNode(child, depth + 1, ctx, [...ancestors, node]);
			if (childOutput) {
				lines.push(childOutput);
			}
		}

		return lines.join('\n');
	}

	// Handle iframes
	if (node.isFrame && node.contentDocument) {
		lines.push(`${indent}|IFRAME|`);

		const contentOutput = serializeNode(node.contentDocument, depth + 1, ctx, []);
		if (contentOutput) {
			lines.push(contentOutput);
		}

		return lines.join('\n');
	}

	// Build element string
	const isNodeInteractive = isInteractive(node);
	let prefix = '';

	if (isNodeInteractive) {
		ctx.index++;
		const index = ctx.index;

		// Build and store selector
		const selector = buildSelector(node, ancestors);
		ctx.selectorMap.set(index, selector);

		// Check if this is a new element
		const isNew = ctx.previousState ? !ctx.previousState.has(node.nodeId) : false;
		prefix = isNew ? `*[${index}]` : `[${index}]`;
	}

	// Handle scrollable containers
	if (node.isScrollable) {
		const scrollInfo = getScrollInfo(node);
		prefix = `|SCROLL|${prefix}`;

		if (scrollInfo) {
			prefix = `${prefix} ${scrollInfo}`;
		}
	}

	// Build attributes
	const attrString = buildAttributeString(node, ctx.includeAttributes);
	const attrPart = attrString ? ` ${attrString}` : '';

	// Build content
	const textContent = truncateText(node.textContent, ctx.maxTextLength);

	// Check if element has visible element children (not text nodes)
	const hasVisibleChildren = node.children.some(
		(c) => c.nodeType !== 'TEXT_NODE' && c.tagName !== '#text' && isVisible(c)
	);
	const hasShadowRoots = node.shadowRoots.length > 0;

	if (!hasVisibleChildren && !hasShadowRoots && !textContent) {
		// Self-closing tag
		lines.push(`${indent}${prefix}<${tagName}${attrPart} />`);
	} else if (!hasVisibleChildren && !hasShadowRoots) {
		// Element with just text content
		lines.push(`${indent}${prefix}<${tagName}${attrPart}>${textContent}</${tagName}>`);
	} else {
		// Element with children
		if (textContent && !hasVisibleChildren) {
			lines.push(`${indent}${prefix}<${tagName}${attrPart}>${textContent}</${tagName}>`);
		} else {
			lines.push(`${indent}${prefix}<${tagName}${attrPart}>`);

			// Serialize shadow roots first
			for (const shadow of node.shadowRoots) {
				const shadowOutput = serializeNode(shadow, depth + 1, ctx, [...ancestors, node]);
				if (shadowOutput) {
					lines.push(shadowOutput);
				}
			}

			// Serialize children
			for (const child of node.children) {
				const childOutput = serializeNode(child, depth + 1, ctx, [...ancestors, node]);
				if (childOutput) {
					lines.push(childOutput);
				}
			}

			lines.push(`${indent}</${tagName}>`);
		}
	}

	return lines.join('\n');
}

/**
 * Serialize tree to browser-use format string
 */
export function serializeTree(
	root: RawDOMNode,
	options: GetLLMTreeOptions = {}
): LLMTreeResult {
	const ctx: SerializationContext = {
		index: 0,
		selectorMap: new Map(),
		previousState: options.previousState,
		maxTextLength: options.maxTextLength ?? 100,
		includeAttributes: DEFAULT_INCLUDE_ATTRIBUTES,
	};

	const treeString = serializeNode(root, 0, ctx, []);

	return {
		tree: treeString,
		selectorMap: ctx.selectorMap,
	};
}

/**
 * Assign indices to interactive elements and build selector map
 * Returns a map of nodeId -> index
 */
export function assignIndices(root: RawDOMNode): Map<number, number> {
	const nodeToIndex = new Map<number, number>();
	let index = 0;

	function walk(node: RawDOMNode): void {
		if (isInteractive(node) && isVisible(node)) {
			index++;
			nodeToIndex.set(node.nodeId, index);
		}

		for (const child of node.children) {
			walk(child);
		}

		for (const shadow of node.shadowRoots) {
			walk(shadow);
		}

		if (node.contentDocument) {
			walk(node.contentDocument);
		}
	}

	walk(root);
	return nodeToIndex;
}

/**
 * Build selector map from node indices
 */
export function buildSelectorMap(
	root: RawDOMNode,
	nodeToIndex: Map<number, number>
): Map<number, string> {
	const selectorMap = new Map<number, string>();

	function walk(node: RawDOMNode, ancestors: RawDOMNode[]): void {
		const index = nodeToIndex.get(node.nodeId);

		if (index !== undefined) {
			const selector = buildSelector(node, ancestors);
			selectorMap.set(index, selector);
		}

		for (const child of node.children) {
			walk(child, [...ancestors, node]);
		}

		for (const shadow of node.shadowRoots) {
			walk(shadow, [...ancestors, node]);
		}

		if (node.contentDocument) {
			walk(node.contentDocument, []);
		}
	}

	walk(root, []);
	return selectorMap;
}
