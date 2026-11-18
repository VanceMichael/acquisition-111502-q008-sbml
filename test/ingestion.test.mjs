import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseXml, XmlParser } from '../src/xml.mjs';
import { interpretSbml, SBML_NS, MATHML_NS } from '../src/sbml.mjs';
import { harness } from './harness.mjs';
import descriptor from '../fixtures/descriptor.json' with { type: 'json' };

const wrap = inner => Buffer.from(`<?xml version="1.0"?><sbml xmlns="${SBML_NS}" level="3" version="2"><model id="m">${inner}</model></sbml>`);

test('解析器拒绝 DTD 与未声明实体，不进行任何外部解析', () => {
  const doctype = Buffer.from('<?xml version="1.0"?><!DOCTYPE sbml [<!ENTITY x "y">]><sbml/>');
  const parsed = parseXml(doctype, { lenient: true });
  assert.equal(parsed.root, null);
  assert.ok(parsed.issues.some(issue => issue.reason === 'xml_doctype_or_declaration_unsupported'));
  const cdata = Buffer.from('<root><![CDATA[<not-a-tag/>]]></root>');
  assert.ok(parseXml(cdata, { lenient: true }).issues.some(issue => issue.reason === 'xml_cdata_unsupported'));
  assert.throws(() => parseXml(Buffer.from('<sbml><model></sbml>')));
  const entity = wrap('<listOfParameters><parameter id="p" value="&undeclared;"/></listOfParameters>');
  const result = interpretSbml(entity, { receiptId: 'r' });
  assert.ok(result.issues.some(issue => issue.reason === 'xml_unsupported_entity_reference'));
  assert.ok(result.records.find(record => record.kind === 'parameter' && record.value.id === 'p'));
});

test('预定义实体与数字字符引用按 XML 规则展开，行列与字节位置可复核', () => {
  const bytes = Buffer.from('<root a="A &amp; B">&#65;</root>');
  const { root, issues } = parseXml(bytes);
  assert.equal(issues.length, 0);
  assert.equal(root.attributes[0].value, 'A & B');
  assert.equal(root.children[0].text, 'A');
  const multiline = Buffer.from('<root>\n  <a/>\n</root>');
  const nested = parseXml(multiline).root.children.find(child => child.type === 'element');
  assert.equal(nested.location.line, 2);
  assert.equal(nested.location.column, 3);
  assert.equal(multiline.toString('utf8', nested.location.byteStart, nested.location.byteEnd), '<a/>');
});

test('同名物种按 id 与隔室保持为不同对象，初始值原样保存不换算', () => {
  const result = interpretSbml(Buffer.from(`<?xml version="1.0"?><sbml xmlns="${SBML_NS}" level="3" version="2"><model id="m">
    <listOfCompartments><compartment id="c1" constant="true"/><compartment id="c2" constant="true"/></listOfCompartments>
    <listOfSpecies>
      <species id="A" name="same" compartment="c1" initialConcentration="3.5"/>
      <species id="B" name="same" compartment="c2" initialAmount="7"/>
    </listOfSpecies></model></sbml>`), { receiptId: 'r' });
  const species = result.records.filter(record => record.kind === 'species');
  assert.deepEqual(species.map(record => record.key), ['A', 'B']);
  const a = species[0].value;
  const b = species[1].value;
  assert.equal(a.initialKind, 'concentration');
  assert.equal(a.initialConcentration, '3.5');
  assert.equal(a.initialAmount, null);
  assert.equal(b.initialKind, 'amount');
  assert.equal(b.initialAmount, '7');
  assert.equal(b.initialConcentration, null);
  assert.ok(result.issues.some(issue => issue.reason === 'sbml_species_shared_name' && issue.name === 'same'));
});

test('局部参数不覆盖全局参数，数学引用按反应作用域核对并保留 MathML 原文', () => {
  const result = interpretSbml(wrap(`
    <listOfParameters><parameter id="k" value="1" constant="true"/></listOfParameters>
    <listOfReactions><reaction id="r1" reversible="false"><kineticLaw>
      <math xmlns="${MATHML_NS}"><apply><plus/><ci>k</ci><ci>ghost</ci></apply></math>
      <listOfLocalParameters><localParameter id="k" value="0.4"/></listOfLocalParameters>
    </kineticLaw></reaction></listOfReactions>`), { receiptId: 'r' });
  const parameters = result.records.filter(record => record.kind === 'parameter');
  assert.deepEqual(parameters.map(record => record.key), ['model:k', 'reaction:r1:k']);
  assert.equal(parameters.find(record => record.key === 'model:k').value.value, '1');
  assert.equal(parameters.find(record => record.key === 'reaction:r1:k').value.value, '0.4');
  const math = result.records.find(record => record.kind === 'reactionKineticMath');
  assert.ok(math.value.mathml.includes('<ci>ghost</ci>'));
  assert.ok(result.issues.some(issue => issue.reason === 'sbml_math_reference_unresolved' && issue.symbol === 'ghost'));
});

test('规则、事件与扩展包逐条登记出处，未支持扩展明确标注边界', () => {
  const result = interpretSbml(Buffer.from(`<?xml version="1.0"?><sbml xmlns="${SBML_NS}" xmlns:distrib="http://www.sbml.org/sbml/level3/version1/distrib/version1" distrib:required="false" level="3" version="2"><model id="m">
    <listOfParameters><parameter id="p" value="1" constant="false"/></listOfParameters>
    <listOfRules><assignmentRule variable="p"><math xmlns="${MATHML_NS}"><ci>p</ci></math></assignmentRule></listOfRules>
    <listOfEvents><event id="e1"><trigger><math xmlns="${MATHML_NS}"><apply><gt/><ci>p</ci><cn>1</cn></apply></math></trigger>
      <listOfEventAssignments><eventAssignment variable="p"><math xmlns="${MATHML_NS}"><cn>2</cn></math></eventAssignment></listOfEventAssignments>
    </event></listOfEvents>
    <distrib:uncertainty id="u1"><distrib:span>3</distrib:span></distrib:uncertainty>
  </model></sbml>`), { receiptId: 'r' });
  assert.ok(result.records.find(record => record.kind === 'rule' && record.value.variable === 'p'));
  const event = result.records.find(record => record.kind === 'event');
  assert.ok(event.value.triggerMath.includes('<apply>'));
  assert.equal(event.value.assignments[0].variable, 'p');
  const packageRecord = result.records.find(record => record.kind === 'extension' && record.key === 'package:distrib');
  assert.equal(packageRecord.value.supported, false);
  assert.equal(packageRecord.value.required, 'false');
  const elementRecord = result.records.find(record => record.kind === 'extension' && record.value.elementName === 'distrib:uncertainty');
  assert.ok(elementRecord.value.rawXml.includes('distrib:uncertainty'));
  assert.ok(result.issues.some(issue => issue.reason === 'sbml_package_unsupported' && issue.packageName === 'distrib'));
  assert.ok(result.issues.some(issue => issue.reason === 'sbml_extension_unsupported'));
});

test('单位定义保留原始分量，自定义单位可被引用，未知单位明确留 issue', () => {
  const result = interpretSbml(wrap(`
    <listOfUnitDefinitions><unitDefinition id="flob"><listOfUnits>
      <unit kind="mole" exponent="1" scale="0" multiplier="1"/>
      <unit kind="litre" exponent="-1" scale="0" multiplier="1"/>
    </listOfUnits></unitDefinition></listOfUnitDefinitions>
    <listOfParameters><parameter id="p" value="2" units="flob" constant="true"/><parameter id="q" value="3" units="mystery" constant="true"/></listOfParameters>`), { receiptId: 'r' });
  const unitDefinition = result.records.find(record => record.kind === 'unitDefinition' && record.key === 'flob');
  assert.deepEqual(unitDefinition.value.units.map(unit => unit.kind), ['mole', 'litre']);
  assert.equal(unitDefinition.value.units[1].exponent, '-1');
  const p = result.records.find(record => record.kind === 'parameter' && record.key === 'model:p');
  assert.equal(p.value.units, 'flob');
  assert.ok(!result.issues.some(issue => issue.holder === 'p'));
  assert.ok(result.issues.some(issue => issue.reason === 'sbml_unit_reference_unknown' && issue.unitId === 'mystery'));
});

test('未知单位与悬空引用产生 issue，而不是静默丢弃', () => {
  const result = interpretSbml(wrap(`
    <listOfCompartments><compartment id="c" units="nope" constant="true"/></listOfCompartments>
    <listOfSpecies><species id="s" compartment="missing"/></listOfSpecies>
    <listOfReactions><reaction id="r1" reversible="false"><listOfReactants><speciesReference species="gone"/></listOfReactants></reaction></listOfReactions>`), { receiptId: 'r' });
  assert.ok(result.issues.some(issue => issue.reason === 'sbml_unit_reference_unknown' && issue.unitId === 'nope'));
  assert.ok(result.issues.some(issue => issue.reason === 'sbml_species_compartment_unknown'));
  assert.ok(result.issues.some(issue => issue.reason === 'sbml_reaction_species_unknown' && issue.speciesId === 'gone'));
  for (const issue of result.issues) assert.ok(issue.location.length > 0 && issue.receiptId === 'r');
});

test('截断文件保留已完整元素并把截断点登记为未决 issue', async () => {
  const bytes = await readFile(new URL('../fixtures/model.xml.partial', import.meta.url));
  const result = interpretSbml(bytes, { receiptId: 'r' });
  assert.equal(result.records.find(record => record.kind === 'species' && record.key === 'S2').value.initialAmount, '2');
  assert.ok(result.records.find(record => record.kind === 'parameter' && record.key === 'reaction:r1:k'));
  const truncation = result.issues.find(issue => issue.reason === 'sbml_input_truncated');
  assert.ok(truncation);
  assert.equal(truncation.totalBytes, bytes.length);
});

test('重复接入同一修订幂等，记录与问题不重复且重启后仍可回查', async () => {
  const context = await harness();
  try {
    const payload = { collectionId: 'idem', entry: context.source + descriptor.entry, options: {} };
    const first = await context.call('/acquisitions', payload);
    const second = await context.call('/acquisitions', payload);
    assert.deepEqual(second.value.receiptIds, first.value.receiptIds);
    const before = (await context.call('/collections/idem')).value;
    await context.restart();
    const after = (await context.call('/collections/idem')).value;
    assert.deepEqual(after.records, before.records);
    assert.deepEqual(after.issues, before.issues);
    const repeated = await context.call('/acquisitions', payload);
    const again = (await context.call('/collections/idem')).value;
    assert.deepEqual(again.records, after.records);
    assert.deepEqual(again.issues, after.issues);
    assert.equal(repeated.value.receiptIds.length, first.value.receiptIds.length);
  } finally { await context.close(); }
});

test('自动接入的每条记录都绑定本资料集真实收件与可复查位置', async () => {
  const context = await harness();
  try {
    await context.call('/acquisitions', { collectionId: 'trace', entry: context.source + descriptor.entry, options: {} });
    const collection = (await context.call('/collections/trace')).value;
    assert.ok(collection.receiptIds.length >= 2);
    const receipts = new Set(collection.receiptIds);
    const bodies = new Map();
    for (const record of collection.records) {
      assert.ok(record.provenance.length > 0);
      for (const origin of record.provenance) {
        assert.ok(receipts.has(origin.receiptId));
        assert.match(origin.location, /^byte:\d+-\d+/);
        const receipt = await context.call('/receipts/' + origin.receiptId);
        assert.equal(receipt.status, 200);
      }
    }
    // 保留的 MathML 必须与收件正文中对应字节区间逐字节一致。
    const mathRecord = collection.records.find(record => record.kind === 'reactionKineticMath');
    const origin = mathRecord.provenance[0];
    if (!bodies.has(origin.receiptId)) {
      bodies.set(origin.receiptId, Buffer.from(await fetch(context.base + '/receipts/' + origin.receiptId + '/body').then(response => response.arrayBuffer())));
    }
    const body = bodies.get(origin.receiptId);
    assert.equal(body.toString('utf8', mathRecord.value.byteStart, mathRecord.value.byteEnd), mathRecord.value.mathml);
  } finally { await context.close(); }
});

test('位置字符串格式化包含字节区间与行列', () => {
  const text = XmlParser.formatLocation({ byteStart: 8, byteEnd: 12, line: 2, column: 3 });
  assert.equal(text, 'byte:8-12;line=2;col=3');
});

test('接入入口缺失或畸形时返回 4xx，且不产生任何来源请求', async () => {
  const context = await harness();
  try {
    assert.equal((await context.call('/acquisitions', { collectionId: 'bad', entry: '' })).status, 400);
    assert.equal((await context.call('/acquisitions', { collectionId: 'bad', entry: 'not a url' })).status, 400);
    assert.equal((await context.call('/acquisitions', { collectionId: 'bad', entry: 'http://outside.invalid/x' })).status, 403);
    assert.equal(context.provider.requests.length, 0);
  } finally { await context.close(); }
});
