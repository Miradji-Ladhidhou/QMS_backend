import mammoth from 'mammoth';
import JSZip from 'jszip';
import { parseDocument } from 'htmlparser2';
import { makeBlockId, textToParagraphBlocks } from '../lib/procedureBlocks.js';

const DEFAULT_SECTION_LABEL = 'Contenu repris du document source';

function childElements(node) {
  return (node.children || []).filter((child) => child.type === 'tag');
}

function textContent(node) {
  if (node.type === 'text') return node.data || '';
  if (node.name === 'br') return '\n';
  return (node.children || []).map(textContent).join('');
}

function normalizedText(node) {
  return textContent(node).replace(/\s+/g, ' ').trim();
}

function onlyBoldText(node, bold = false) {
  if (node.type === 'text') return !node.data.trim() || bold;
  const childBold = bold || node.name === 'strong' || node.name === 'b';
  const children = node.children || [];
  return children.length > 0 && children.every((child) => onlyBoldText(child, childBold));
}

function numberedHeading(text) {
  const match = text.match(/^(\d+)[.)]\s+(.+)$/);
  return match ? match[2].trim() : null;
}

function isMainHeading(node, text) {
  return node.name === 'h1' || !!numberedHeading(text) && onlyBoldText(node);
}

function isSubheading(node, text) {
  return ['h2', 'h3', 'h4'].includes(node.name) || /^\d+\.\d+\s+\S/.test(text) || onlyBoldText(node) && text.length <= 140;
}

function sectionKey(label, index, usedKeys) {
  const base = label
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || `section-${index + 1}`;
  let key = base;
  let suffix = 2;
  while (usedKeys.has(key)) {
    key = `${base}-${suffix}`;
    suffix += 1;
  }
  usedKeys.add(key);
  return key;
}

function createSection(label, index, usedKeys, blocks = []) {
  return { key: sectionKey(label, index, usedKeys), label, blocks };
}

function tableBlock(table, shadedHeaderRow = false) {
  const rows = [];
  const visitRows = (node) => {
    if (node.name === 'tr') {
      const cells = childElements(node).filter((child) => child.name === 'td' || child.name === 'th');
      if (cells.length) rows.push(cells);
      return;
    }
    childElements(node).forEach(visitRows);
  };
  visitRows(table);
  if (!rows.length) return null;

  const columnCount = Math.max(...rows.map((row) => row.length));
  const firstRowIsHeader = shadedHeaderRow ||
    rows[0].length === columnCount &&
    rows[0].every((cell) => cell.name === 'th' || onlyBoldText(cell));
  const headers = firstRowIsHeader
    ? rows[0].map(normalizedText)
    : Array.from({ length: columnCount }, (_, index) => `Colonne ${index + 1}`);
  const dataRows = firstRowIsHeader ? rows.slice(1) : rows;

  return {
    type: 'tableau',
    id: makeBlockId(),
    hasHeader: firstRowIsHeader,
    headers,
    rows: dataRows.map((row) => Array.from({ length: columnCount }, (_, index) => normalizedText(row[index] || { children: [] }))),
  };
}

function listBlocks(list, depth = 0) {
  const ordered = list.name === 'ol';
  const items = childElements(list).filter((child) => child.name === 'li');
  const blocks = [];

  items.forEach((item, index) => {
    const nestedLists = childElements(item).filter((child) => child.name === 'ul' || child.name === 'ol');
    const itemText = (item.children || [])
      .filter((child) => child.name !== 'ul' && child.name !== 'ol')
      .map(textContent)
      .join('')
      .replace(/\s+/g, ' ')
      .trim();

    if (itemText) {
      if (!ordered && depth === 0) {
        blocks.push({ type: 'liste_puces', id: makeBlockId(), items: [itemText] });
      } else {
        const marker = ordered ? `${index + 1}.` : '•';
        blocks.push({
          type: 'paragraphe',
          id: makeBlockId(),
          text: `${'  '.repeat(depth)}${marker} ${itemText}`,
        });
      }
    }
    nestedLists.forEach((nested) => blocks.push(...listBlocks(nested, depth + 1)));
  });

  return blocks;
}

function nodeBlocks(node, shadedHeaderRow = false) {
  if (node.name === 'table') {
    const block = tableBlock(node, shadedHeaderRow);
    return block ? [block] : [];
  }
  if (node.name === 'ul' || node.name === 'ol') return listBlocks(node);
  if (node.name !== 'p' && !/^h[1-4]$/.test(node.name || '')) return [];

  const text = normalizedText(node);
  if (!text) return [];
  if (isSubheading(node, text) && !isMainHeading(node, text)) {
    return [{ type: 'sous_titre', id: makeBlockId(), text }];
  }
  return textToParagraphBlocks(text);
}

export function procedureSectionsFromHtml(html, { description = '', documentTitle = '', shadedTableHeaders = [] } = {}) {
  const root = parseDocument(html || '');
  const nodes = childElements(root).filter((node) => node.name !== 'script' && node.name !== 'style');
  const firstNumberedHeading = nodes.findIndex(
    (node) =>
      (node.name === 'p' || /^h[1-4]$/.test(node.name || '')) &&
      numberedHeading(normalizedText(node)) &&
      (node.name !== 'p' || onlyBoldText(node))
  );
  const firstHeading = nodes.findIndex((node) => node.name === 'h1');
  const startIndex = firstNumberedHeading >= 0 ? firstNumberedHeading : firstHeading;
  const hasStructuredHeadings = startIndex >= 0;
  const startNodes = hasStructuredHeadings ? nodes.slice(startIndex) : nodes;
  let tableIndex = nodes.slice(0, hasStructuredHeadings ? startIndex : 0).filter((node) => node.name === 'table').length;
  const sections = [];
  const usedKeys = new Set();
  let current = null;

  const startSection = (label) => {
    if (current && (current.blocks.length || current.label !== DEFAULT_SECTION_LABEL)) sections.push(current);
    current = createSection(label || DEFAULT_SECTION_LABEL, sections.length, usedKeys);
  };

  if (!hasStructuredHeadings) {
    current = createSection(DEFAULT_SECTION_LABEL, 0, usedKeys);
  }

  startNodes.forEach((node) => {
    const text = normalizedText(node);
    if (isMainHeading(node, text)) {
      const label = numberedHeading(text) || text;
      if (documentTitle && label.localeCompare(documentTitle.trim(), undefined, { sensitivity: 'accent' }) === 0 && !current) {
        current = createSection(DEFAULT_SECTION_LABEL, sections.length, usedKeys);
      } else {
        startSection(label);
      }
      return;
    }
    if (!current) current = createSection(DEFAULT_SECTION_LABEL, sections.length, usedKeys);
    const shadedHeaderRow = node.name === 'table' ? shadedTableHeaders[tableIndex++] === true : false;
    current.blocks.push(...nodeBlocks(node, shadedHeaderRow));
  });

  if (current && (current.blocks.length || !sections.length)) sections.push(current);
  if (!sections.length) sections.push(createSection(DEFAULT_SECTION_LABEL, 0, usedKeys));

  if (description) {
    sections[0].blocks.unshift(...textToParagraphBlocks(description));
  }
  return sections;
}

export async function extractProcedureSectionsFromDocx(buffer, options = {}) {
  const [result, shadedTableHeaders] = await Promise.all([
    mammoth.convertToHtml(
      { buffer },
      { convertImage: mammoth.images.imgElement(() => Promise.resolve({ alt: 'Image du document source' })) }
    ),
    docxTableHeaderRows(buffer),
  ]);
  return procedureSectionsFromHtml(result.value, { ...options, shadedTableHeaders });
}

async function docxTableHeaderRows(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const documentXml = await zip.file('word/document.xml')?.async('string');
  if (!documentXml) throw new Error('Le contenu Word du document source est introuvable.');

  const root = parseDocument(documentXml, { xmlMode: true });
  const tables = [];
  function collectTables(node) {
    if (node.name === 'w:tbl') {
      tables.push(node);
      return;
    }
    childElements(node).forEach(collectTables);
  }
  collectTables(root);

  return tables.map((table) => {
    const firstRow = childElements(table).find((child) => child.name === 'w:tr');
    const cells = firstRow ? childElements(firstRow).filter((child) => child.name === 'w:tc') : [];
    if (cells.length < 2) return false;

    const shadedHeader = cells.every((cell) => {
      const properties = childElements(cell).find((child) => child.name === 'w:tcPr');
      const shading = properties && childElements(properties).find((child) => child.name === 'w:shd');
      const fill = shading?.attribs?.['w:fill']?.toUpperCase();
      return Boolean(fill && fill !== 'AUTO' && fill !== 'FFFFFF');
    });
    if (shadedHeader) return true;

    const labels = cells.map(normalizedText);
    return (
      labels.length >= 3 &&
      labels.every((label) => label.length > 0 && label.length <= 36) &&
      new Set(labels.map((label) => label.toLocaleLowerCase())).size === labels.length &&
      labels.every((label) => !/^[\d./-]+$/.test(label))
    );
  });
}
