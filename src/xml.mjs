// 面向收件解释的最小 XML 解析器。
// 只接受可安全解释的语法：拒绝 DTD 与自定义实体，不触发任何联网或外部读取。
// 每个元素记录原文字节区间，供出处回查；文本保留原始写法，不做规范化。

const WHITESPACE = new Set([' ', '\t', '\n', '\r']);
const NAME_END = new Set([' ', '\t', '\n', '\r', '<', '>', '/', '=', '"', "'", '?', '&']);
const PREDEFINED_ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const ENTITY_PATTERN = /^&(lt|gt|amp|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);/;

export class XmlSyntaxError extends Error {
  constructor(syntax, offset) {
    super(syntax);
    this.syntax = syntax;
    this.offset = offset;
  }
}

function byteWidth(codePoint) {
  return codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
}

function decodeEntity(body) {
  if (body in PREDEFINED_ENTITIES) return PREDEFINED_ENTITIES[body];
  const codePoint = body.startsWith('#x') ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10FFFF) return null;
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return null;
  }
}

export function parseXmlDocument(text) {
  const state = { text, index: 0, byte: 0 };

  function fail(syntax) {
    throw new XmlSyntaxError(syntax, state.byte);
  }

  function startsWith(prefix) {
    return text.startsWith(prefix, state.index);
  }

  function advanceAscii(count) {
    state.index += count;
    state.byte += count;
  }

  function advanceChar() {
    const codePoint = text.codePointAt(state.index);
    state.index += codePoint > 0xFFFF ? 2 : 1;
    state.byte += byteWidth(codePoint);
  }

  function expect(prefix) {
    if (!startsWith(prefix)) fail('expected_' + prefix.replace(/\W/g, '_'));
    advanceAscii(prefix.length);
  }

  function skipWhitespace() {
    while (state.index < text.length && WHITESPACE.has(text[state.index])) advanceChar();
  }

  function parseName() {
    const start = state.index;
    while (state.index < text.length && !NAME_END.has(text[state.index])) advanceChar();
    if (state.index === start) fail('expected_name');
    return text.slice(start, state.index);
  }

  function decodeEntities(raw, rawByteOffset) {
    let output = '';
    let cursor = 0;
    for (;;) {
      const amp = raw.indexOf('&', cursor);
      if (amp === -1) return output + raw.slice(cursor);
      output += raw.slice(cursor, amp);
      const match = ENTITY_PATTERN.exec(raw.slice(amp));
      if (!match) throw new XmlSyntaxError('undefined_entity', rawByteOffset + Buffer.byteLength(raw.slice(0, amp), 'utf8'));
      const decoded = decodeEntity(match[1]);
      if (decoded === null) throw new XmlSyntaxError('invalid_character_reference', rawByteOffset + Buffer.byteLength(raw.slice(0, amp), 'utf8'));
      output += decoded;
      cursor = amp + match[0].length;
    }
  }

  function skipComment() {
    expect('<!--');
    const close = text.indexOf('-->', state.index);
    if (close === -1) fail('unexpected_eof');
    while (state.index < close) advanceChar();
    advanceAscii(3);
  }

  function skipProcessingInstruction() {
    expect('<?');
    const close = text.indexOf('?>', state.index);
    if (close === -1) fail('unexpected_eof');
    while (state.index < close) advanceChar();
    advanceAscii(2);
  }

  function parseText() {
    const start = state.byte;
    const startIndex = state.index;
    while (state.index < text.length && text[state.index] !== '<') advanceChar();
    const raw = text.slice(startIndex, state.index);
    decodeEntities(raw, start);
    return { text: raw, start, end: state.byte };
  }

  function parseCdata() {
    expect('<![CDATA[');
    const start = state.byte;
    const startIndex = state.index;
    const close = text.indexOf(']]>', state.index);
    if (close === -1) fail('unexpected_eof');
    while (state.index < close) advanceChar();
    const raw = text.slice(startIndex, state.index);
    advanceAscii(3);
    return { text: raw, start, end: state.byte };
  }

  function parseElement() {
    const start = state.byte;
    expect('<');
    const name = parseName();
    const attributes = [];
    const seen = new Set();
    for (;;) {
      skipWhitespace();
      if (state.index >= text.length) fail('unexpected_eof');
      if (startsWith('/>')) {
        advanceAscii(2);
        return { name, attributes, children: [], start, end: state.byte, contentStart: state.byte, contentEnd: state.byte };
      }
      if (text[state.index] === '>') {
        advanceAscii(1);
        break;
      }
      const attributeName = parseName();
      if (seen.has(attributeName)) fail('duplicate_attribute');
      seen.add(attributeName);
      skipWhitespace();
      expect('=');
      skipWhitespace();
      const quote = text[state.index];
      if (quote !== '"' && quote !== "'") fail('expected_attribute_quote');
      advanceAscii(1);
      const valueByte = state.byte;
      const valueIndex = state.index;
      while (state.index < text.length && text[state.index] !== quote) {
        if (text[state.index] === '<') fail('markup_in_attribute');
        advanceChar();
      }
      if (state.index >= text.length) fail('unexpected_eof');
      const raw = text.slice(valueIndex, state.index);
      const value = decodeEntities(raw, valueByte);
      advanceAscii(1);
      attributes.push({ name: attributeName, value });
    }
    const children = [];
    const contentStart = state.byte;
    for (;;) {
      if (state.index >= text.length) fail('unexpected_eof');
      if (startsWith('</')) {
        const contentEnd = state.byte;
        advanceAscii(2);
        const closing = parseName();
        skipWhitespace();
        expect('>');
        if (closing !== name) fail('mismatched_end_tag');
        return { name, attributes, children, start, end: state.byte, contentStart, contentEnd };
      }
      if (startsWith('<!--')) { skipComment(); continue; }
      if (startsWith('<![CDATA[')) { children.push(parseCdata()); continue; }
      if (startsWith('<!')) fail('markup_declaration_not_allowed');
      if (startsWith('<?')) { skipProcessingInstruction(); continue; }
      if (text[state.index] === '<') { children.push(parseElement()); continue; }
      children.push(parseText());
    }
  }

  function skipMisc() {
    for (;;) {
      skipWhitespace();
      if (startsWith('<!--')) { skipComment(); continue; }
      if (startsWith('<?')) { skipProcessingInstruction(); continue; }
      return;
    }
  }

  if (text.codePointAt(0) === 0xFEFF) advanceChar();
  if (startsWith('<?xml')) skipProcessingInstruction();
  skipMisc();
  if (startsWith('<!DOCTYPE')) fail('dtd_not_allowed');
  if (startsWith('<!')) fail('markup_declaration_not_allowed');
  if (text[state.index] !== '<') fail('expected_root_element');
  const root = parseElement();
  skipMisc();
  if (state.index < text.length) fail('trailing_content');
  return root;
}

const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NAMESPACE = 'http://www.w3.org/2000/xmlns/';

function splitQualifiedName(name) {
  const colon = name.indexOf(':');
  if (colon === -1) return { prefix: null, local: name };
  return { prefix: name.slice(0, colon), local: name.slice(colon + 1) };
}

export function resolveNamespaces(root) {
  function walk(node, inherited) {
    const scope = { ...inherited };
    for (const attribute of node.attributes) {
      if (attribute.name === 'xmlns') scope[''] = attribute.value;
      else if (attribute.name.startsWith('xmlns:')) scope[attribute.name.slice(6)] = attribute.value;
    }
    const { prefix, local } = splitQualifiedName(node.name);
    node.prefix = prefix;
    node.local = local;
    if (prefix) {
      if (!(prefix in scope)) throw new XmlSyntaxError('unbound_prefix', node.start);
      node.ns = scope[prefix];
    } else {
      node.ns = scope[''] || null;
    }
    for (const attribute of node.attributes) {
      const parts = splitQualifiedName(attribute.name);
      attribute.prefix = parts.prefix;
      attribute.local = parts.local;
      if (attribute.name === 'xmlns' || parts.prefix === 'xmlns') attribute.ns = XMLNS_NAMESPACE;
      else if (parts.prefix) {
        if (!(parts.prefix in scope)) throw new XmlSyntaxError('unbound_prefix', node.start);
        attribute.ns = scope[parts.prefix];
      } else attribute.ns = null;
    }
    for (const child of node.children) {
      if (Object.hasOwn(child, 'name')) walk(child, scope);
    }
  }
  walk(root, { xml: XML_NAMESPACE });
  return root;
}

export function elementChildren(node) {
  return node.children.filter(child => Object.hasOwn(child, 'name'));
}

export function decodeText(node) {
  let raw = '';
  for (const child of node.children) {
    if (Object.hasOwn(child, 'text')) raw += child.text;
  }
  return raw.replace(/&(lt|gt|amp|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);/g, (entity, body) => decodeEntity(body) ?? entity);
}
