// 命名空间感知的安全 XML 解析器：只用于接收资料的结构化接入。
// 明确不支持 DTD、实体声明、外部/网络实体；文本中只允许 XML 预定义实体与数字字符引用。
// 所有位置基于原始 UTF-8 字节区间，并附行、列，可回到真实收件正文复核。
// lenient 模式下，截断（文件结束于标签或元素中间）只登记 issue 并保留已完整解析的元素，
// 不猜测、不补全来源没有的内容。

const NAMESPACE_XMLNS = 'http://www.w3.org/2000/xmlns/';
const NAMESPACE_XML = 'http://www.w3.org/XML/1998/namespace';
const PREDEFINED_ENTITIES = { lt: '<', gt: '>', amp: '&', apos: "'", quot: '"' };

function isNameStart(code) {
  return code === 0x3a || code === 0x5f || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || code >= 0xc0;
}

function isNameChar(code) {
  if (isNameStart(code)) return true;
  return code === 0x2d || code === 0x2e || (code >= 0x30 && code <= 0x39) || code === 0xb7 || code === 0x203f || code === 0x2040;
}

export class XmlParser {
  constructor(bytes, { lenient = false } = {}) {
    this.bytes = bytes instanceof Uint8Array ? bytes : Buffer.from(bytes);
    this.lenient = lenient;
    this.pos = 0;
    this.line = 1;
    this.col = 1;
    this.issues = [];
  }

  get length() {
    return this.bytes.length;
  }

  get eof() {
    return this.pos >= this.length;
  }

  byteAt(offset = 0) {
    return this.bytes[this.pos + offset];
  }

  startsWith(text) {
    return this.pos + text.length <= this.length && this.bytes.toString('latin1', this.pos, this.pos + text.length) === text;
  }

  fail(reason, location = this.location()) {
    const issue = { reason, location };
    if (!this.lenient) {
      const error = new Error(reason);
      error.issue = issue;
      throw error;
    }
    this.issues.push(issue);
    return issue;
  }

  advance(count = 1) {
    for (let index = 0; index < count; index += 1) {
      const code = this.bytes[this.pos];
      this.pos += 1;
      if (code === 0x0a) {
        this.line += 1;
        this.col = 1;
      } else {
        this.col += 1;
      }
    }
  }

  location(start = this.pos, end = this.pos) {
    const slice = this.bytes.subarray(0, start);
    let line = 1;
    for (const code of slice) if (code === 0x0a) line += 1;
    const lastBreak = slice.lastIndexOf(0x0a);
    return { byteStart: start, byteEnd: end, line, column: start - lastBreak };
  }

  static formatLocation(location) {
    return `byte:${location.byteStart}-${location.byteEnd};line=${location.line};col=${location.column}`;
  }

  skipWhitespace() {
    while (!this.eof) {
      const code = this.byteAt();
      if (code === 0x20 || code === 0x09 || code === 0x0d || code === 0x0a) this.advance();
      else break;
    }
  }

  decode(start, end = this.pos) {
    return this.bytes.toString('utf8', start, end);
  }

  readName() {
    const start = this.pos;
    if (this.eof || !isNameStart(this.byteAt())) {
      this.fail('xml_invalid_name');
      return { name: '', start, end: this.pos };
    }
    this.advance();
    while (!this.eof && isNameChar(this.byteAt())) this.advance();
    return { name: this.decode(start), start, end: this.pos };
  }

  // 读取带引号的属性值，并按 XML 规则展开预定义/数字字符引用。
  readQuoted() {
    const quote = this.byteAt();
    if (quote !== 0x22 && quote !== 0x27) {
      this.fail('xml_attribute_quote_expected');
      return null;
    }
    this.advance();
    let value = '';
    let fragmentStart = this.pos;
    while (!this.eof && this.byteAt() !== quote) {
      const code = this.byteAt();
      if (code === 0x3c) {
        this.fail('xml_lt_in_attribute');
        break;
      }
      if (code === 0x26) {
        value += this.decode(fragmentStart, this.pos);
        value += this.readReference();
        fragmentStart = this.pos;
      } else this.advance();
    }
    value += this.decode(fragmentStart, this.pos);
    if (!this.eof && this.byteAt() === quote) this.advance();
    else this.fail('xml_unclosed_attribute');
    return value;
  }

  // 返回引用展开后的字符；未知实体在 lenient 下保留空串并登记 issue，绝不访问外部资源。
  readReference() {
    const start = this.pos;
    this.advance(); // &
    if (this.startsWith('#')) {
      this.advance();
      const hex = this.startsWith('x') || this.startsWith('X');
      if (hex) this.advance();
      const digitsStart = this.pos;
      while (!this.eof) {
        const code = this.byteAt();
        if ((code >= 0x30 && code <= 0x39) || (hex && ((code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66)))) this.advance();
        else break;
      }
      const digits = this.decode(digitsStart, this.pos);
      if (!digits || this.eof || this.byteAt() !== 0x3b) {
        this.fail('xml_invalid_numeric_reference', this.location(start));
        return '';
      }
      this.advance(); // ;
      const codepoint = parseInt(digits, hex ? 16 : 10);
      if (!Number.isFinite(codepoint) || codepoint > 0x10ffff || (codepoint >= 0xd800 && codepoint <= 0xdfff)) {
        this.fail('xml_invalid_character_reference', this.location(start, this.pos));
        return '';
      }
      return String.fromCodePoint(codepoint);
    }
    const name = this.readName();
    if (this.eof || this.byteAt() !== 0x3b) {
      this.fail('xml_unterminated_reference', this.location(start));
      return '';
    }
    this.advance(); // ;
    if (!Object.hasOwn(PREDEFINED_ENTITIES, name.name)) {
      this.fail('xml_unsupported_entity_reference', this.location(start, this.pos));
      return '';
    }
    return PREDEFINED_ENTITIES[name.name];
  }

  readAttributes() {
    const attributes = [];
    while (true) {
      this.skipWhitespace();
      if (this.eof) {
        this.fail('xml_unclosed_tag');
        return attributes;
      }
      const code = this.byteAt();
      if (code === 0x2f || code === 0x3e) return attributes;
      const nameStart = this.pos;
      const { name } = this.readName();
      if (!name) return attributes;
      this.skipWhitespace();
      if (this.eof || this.byteAt() !== 0x3d) {
        this.fail('xml_attribute_equals_expected', this.location(nameStart));
        return attributes;
      }
      this.advance(); // =
      this.skipWhitespace();
      if (this.eof) {
        this.fail('xml_unclosed_tag');
        return attributes;
      }
      const valueStart = this.pos;
      const value = this.readQuoted();
      attributes.push({ name, value: value ?? '', location: this.location(nameStart, this.pos), valueLocation: this.location(valueStart, Math.max(valueStart, this.pos - 1)) });
    }
  }

  readText() {
    const start = this.pos;
    let text = '';
    let fragmentStart = this.pos;
    while (!this.eof && this.byteAt() !== 0x3c) {
      if (this.byteAt() === 0x26) {
        text += this.decode(fragmentStart, this.pos);
        text += this.readReference();
        fragmentStart = this.pos;
      } else this.advance();
    }
    text += this.decode(fragmentStart, this.pos);
    return { type: 'text', text, location: this.location(start, this.pos) };
  }

  skipMisc() {
    while (!this.eof) {
      this.skipWhitespace();
      if (this.startsWith('<!--')) {
        const start = this.pos;
        this.advance(4);
        while (!this.eof && !this.startsWith('-->')) {
          if (this.startsWith('<!--')) this.fail('xml_nested_comment', this.location(this.pos, this.pos + 4));
          this.advance();
        }
        if (this.startsWith('-->')) this.advance(3);
        else {
          this.fail('xml_unclosed_comment', this.location(start));
          return false;
        }
      } else if (this.startsWith('<?')) {
        const start = this.pos;
        this.advance(2);
        while (!this.eof && !this.startsWith('?>')) this.advance();
        if (this.startsWith('?>')) this.advance(2);
        else {
          this.fail('xml_unclosed_processing_instruction', this.location(start));
          return false;
        }
      } else {
        return true;
      }
    }
    return false;
  }

  readElement(scope) {
    const start = this.pos;
    this.advance(); // <
    if (this.eof || !isNameStart(this.byteAt())) {
      this.fail('xml_element_name_expected');
      return null;
    }
    const { name } = this.readName();
    const attributeList = this.readAttributes();
    const element = {
      type: 'element',
      name,
      prefix: name.includes(':') ? name.slice(0, name.indexOf(':')) : '',
      localName: name.includes(':') ? name.slice(name.indexOf(':') + 1) : name,
      attributes: [],
      children: [],
      location: this.location(start),
      selfClosed: false,
      truncated: false
    };
    const nextScope = {
      start,
      defaults: new Map(scope?.defaults ?? []),
      mappings: new Map(scope?.mappings ?? [])
    };
    for (const attribute of attributeList) {
      let namespaceUri = null;
      if (attribute.name === 'xmlns') {
        nextScope.defaults.set('', attribute.value);
        namespaceUri = NAMESPACE_XMLNS;
      } else if (attribute.name.startsWith('xmlns:')) {
        nextScope.mappings.set(attribute.name.slice(6), attribute.value);
        namespaceUri = NAMESPACE_XMLNS;
      } else if (attribute.name.includes(':')) {
        const prefix = attribute.name.slice(0, attribute.name.indexOf(':'));
        if (prefix === 'xml') namespaceUri = NAMESPACE_XML;
        else namespaceUri = nextScope.mappings.get(prefix) ?? null;
        if (prefix !== 'xml' && !nextScope.mappings.has(prefix)) this.fail('xml_undeclared_namespace_prefix', attribute.location);
      }
      element.attributes.push({ ...attribute, namespaceUri, localName: attribute.name.includes(':') ? attribute.name.slice(attribute.name.indexOf(':') + 1) : attribute.name });
    }
    element.namespaceUri = element.prefix ? (nextScope.mappings.get(element.prefix) ?? null) : (nextScope.defaults.get('') ?? null);
    if (element.prefix && !nextScope.mappings.has(element.prefix)) this.fail('xml_undeclared_namespace_prefix', element.location);
    this.skipWhitespace();
    if (this.eof) {
      this.fail('xml_unclosed_element', element.location);
      element.location.byteEnd = this.pos;
      element.truncated = true;
      return element;
    }
    if (this.byteAt() === 0x2f) {
      this.advance();
      if (!this.eof && this.byteAt() === 0x3e) this.advance();
      else this.fail('xml_unclosed_tag');
      element.location.byteEnd = this.pos;
      element.selfClosed = true;
      return element;
    }
    if (this.byteAt() !== 0x3e) {
      this.fail('xml_tag_terminator_expected');
      element.location.byteEnd = this.pos;
      return element;
    }
    this.advance(); // >
    while (true) {
      if (this.eof) {
        this.fail('xml_unclosed_element', element.location);
        element.truncated = true;
        element.location.byteEnd = this.pos;
        return element;
      }
      if (this.startsWith('</')) {
        const endStart = this.pos;
        this.advance(2);
        const closing = this.readName();
        this.skipWhitespace();
        if (!this.eof && this.byteAt() === 0x3e) this.advance();
        else this.fail('xml_unclosed_end_tag', this.location(endStart));
        if (closing.name && closing.name !== name) this.fail('xml_end_tag_mismatch', this.location(endStart, this.pos));
        element.location.byteEnd = this.pos;
        return element;
      }
      if (this.startsWith('<!--') || this.startsWith('<?')) {
        if (!this.skipMisc()) {
          element.truncated = true;
          element.location.byteEnd = this.pos;
          return element;
        }
        continue;
      }
      if (this.startsWith('<![') || this.startsWith('<!')) {
        // CDATA 段与 DTD 声明都不接入，避免标记隐藏与实体展开面。
        const start = this.pos;
        const isCdata = this.startsWith('<![CDATA[');
        this.advance(2);
        while (!this.eof && this.byteAt() !== 0x3e) this.advance();
        if (!this.eof) this.advance();
        this.fail(isCdata ? 'xml_cdata_unsupported' : 'xml_doctype_or_declaration_unsupported', this.location(start, this.pos));
        continue;
      }
      if (this.byteAt() === 0x3c) {
        const before = this.pos;
        const child = this.readElement(nextScope);
        if (child) element.children.push(child);
        else if (this.pos === before) this.advance(); // 防止畸形输入造成死循环
        if (element.truncated || this.issues.some(issue => issue.reason === 'xml_unclosed_element' || issue.reason === 'xml_unclosed_tag')) {
          element.truncated = true;
          element.location.byteEnd = this.pos;
          return element;
        }
      } else {
        const text = this.readText();
        if (text.text) element.children.push(text);
      }
    }
  }

  parse() {
    const rootScope = { start: -1, defaults: new Map(), mappings: new Map() };
    if (this.length >= 3 && this.bytes[0] === 0xef && this.bytes[1] === 0xbb && this.bytes[2] === 0xbf) this.advance(3);
    while (this.skipMisc(rootScope)) {
      if (this.startsWith('<')) break;
      this.fail('xml_unexpected_content');
      break;
    }
    if (this.eof) {
      this.fail('xml_empty_document');
      return { root: null, issues: this.issues };
    }
    if (this.startsWith('<!')) {
      // DTD、CDATA 段开头等声明式构造一律不接入，避免实体展开与外部资源。
      const start = this.pos;
      const isCdata = this.startsWith('<![CDATA[');
      this.advance(2);
      while (!this.eof && this.byteAt() !== 0x3e) this.advance();
      if (!this.eof) this.advance();
      this.fail(isCdata ? 'xml_cdata_unsupported' : 'xml_doctype_or_declaration_unsupported', this.location(start, this.pos));
      return { root: null, issues: this.issues };
    }
    const root = this.readElement(rootScope);
    if (root && !this.eof) {
      this.skipWhitespace();
      if (this.skipMisc(rootScope) && !this.eof) this.fail('xml_content_after_root', this.location(this.pos, this.length));
    }
    return { root, issues: this.issues };
  }
}

export function parseXml(bytes, options) {
  return new XmlParser(bytes, options).parse();
}

export function childElements(element, localName = null, namespaceUri = null) {
  if (!element) return [];
  return element.children.filter(child => child.type === 'element'
    && (namespaceUri === null || child.namespaceUri === namespaceUri)
    && (localName === null || child.localName === localName));
}

export function findChild(element, localName, namespaceUri = null) {
  return childElements(element, localName, namespaceUri)[0] ?? null;
}

export function attribute(element, localName, namespaceUri = null) {
  if (!element) return null;
  return element.attributes.find(candidate => (namespaceUri === null || candidate.namespaceUri === namespaceUri) && candidate.localName === localName) ?? null;
}

export function textOf(element) {
  if (!element) return '';
  return element.children.filter(child => child.type === 'text').map(child => child.text).join('');
}
