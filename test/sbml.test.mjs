import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { interpretSbml } from '../src/sbml.mjs';
import { Archive } from '../src/archive.mjs';

const fixture = await readFile(new URL('../fixtures/model.xml', import.meta.url));
const RECEIPT = 'a'.repeat(64);

function wrap(body, { level = 3, version = 2 } = {}) {
  return Buffer.from(`<?xml version="1.0"?><sbml xmlns="http://www.sbml.org/sbml/level3/version2/core" level="${level}" version="${version}"><model id="m">${body}</model></sbml>`);
}

function recordsOf(result, kind) {
  return result.records.filter(record => record.kind === kind);
}

test('同名物种在不同隔室是两个对象，初始值按原样保存不换算', () => {
  const { records, issues } = interpretSbml(fixture, RECEIPT);
  assert.deepEqual(issues, []);
  const species = recordsOf({ records }, 'species');
  assert.equal(species.length, 2);
  const [s1, s2] = species;
  assert.equal(s1.value.name, 'X');
  assert.equal(s2.value.name, 'X');
  assert.notEqual(s1.key, s2.key);
  assert.deepEqual(
    { id: s1.value.id, compartment: s1.value.compartment, initialKind: s1.value.initialKind, value: s1.value.value },
    { id: 'S1', compartment: 'cyt', initialKind: 'concentration', value: '1' }
  );
  assert.deepEqual(
    { id: s2.value.id, compartment: s2.value.compartment, initialKind: s2.value.initialKind, value: s2.value.value },
    { id: 'S2', compartment: 'mit', initialKind: 'amount', value: '2' }
  );
});

test('局部参数与同名全局参数分别建档，互不覆盖', () => {
  const { records, issues } = interpretSbml(fixture, RECEIPT);
  assert.deepEqual(issues, []);
  const parameters = recordsOf({ records }, 'parameter');
  assert.equal(parameters.length, 2);
  const global = parameters.find(record => record.value.scope === 'model');
  const local = parameters.find(record => record.value.scope === 'reaction:r1');
  assert.ok(global && local);
  assert.equal(global.value.id, 'k');
  assert.equal(global.value.value, '1');
  assert.equal(local.value.id, 'k');
  assert.equal(local.value.value, '0.4');
  assert.notEqual(global.key, local.key);
});

test('MathML 原文与交付字节逐字节一致，出处区间可切回原文', () => {
  const { records } = interpretSbml(fixture, RECEIPT);
  const reaction = recordsOf({ records }, 'reaction')[0];
  const original = fixture.toString('utf8');
  const mathStart = original.indexOf('<math');
  const mathEnd = original.indexOf('</math>') + '</math>'.length;
  assert.equal(reaction.value.math, original.slice(mathStart, mathEnd));
  for (const record of records) {
    const [start, end] = record.provenance[0].location.replace('bytes:', '').split('-').map(Number);
    const slice = fixture.subarray(start, end).toString('utf8');
    assert.ok(slice.startsWith('<'), record.provenance[0].location);
    assert.ok(slice.length > 0);
  }
});

test('反应参与者、隔室与数学引用全部核对通过时没有问题单', () => {
  const { issues, records } = interpretSbml(fixture, RECEIPT);
  assert.deepEqual(issues, []);
  const reaction = recordsOf({ records }, 'reaction')[0];
  assert.deepEqual(reaction.value.reactants.map(entry => entry.species), ['S1']);
  assert.deepEqual(reaction.value.products.map(entry => entry.species), ['S2']);
});

test('引用未声明的隔室、物种与数学符号分别记为未决问题', () => {
  const bytes = wrap(`
    <listOfCompartments><compartment id="c1" constant="true"/></listOfCompartments>
    <listOfSpecies>
      <species id="s1" compartment="nowhere" constant="false" hasOnlySubstanceUnits="false" boundaryCondition="false"/>
    </listOfSpecies>
    <listOfReactions>
      <reaction id="r1" reversible="false">
        <listOfReactants><speciesReference species="ghost" stoichiometry="1" constant="true"/></listOfReactants>
        <kineticLaw><math xmlns="http://www.w3.org/1998/Math/MathML"><apply><times/><ci>mystery</ci><ci>s1</ci></apply></math></kineticLaw>
      </reaction>
    </listOfReactions>`);
  const { issues } = interpretSbml(bytes, RECEIPT);
  const reasons = issues.map(issue => issue.reason);
  assert.ok(reasons.includes('unknown_compartment_reference'));
  assert.ok(reasons.includes('unknown_species_reference'));
  assert.ok(reasons.includes('unresolved_math_reference'));
  const unresolved = issues.find(issue => issue.reason === 'unresolved_math_reference');
  assert.equal(unresolved.detail.reference, 'mystery');
  for (const issue of issues) {
    assert.ok(issue.location.startsWith('bytes:'), issue.reason);
    assert.equal(issue.receiptId, RECEIPT);
  }
});

test('初始浓度与初始物质量同时出现时记冲突，不自行合并', () => {
  const bytes = wrap(`
    <listOfCompartments><compartment id="c1" constant="true"/></listOfCompartments>
    <listOfSpecies><species id="s1" compartment="c1" initialAmount="3" initialConcentration="9" constant="false" hasOnlySubstanceUnits="false" boundaryCondition="false"/></listOfSpecies>`);
  const { records, issues } = interpretSbml(bytes, RECEIPT);
  assert.ok(issues.some(issue => issue.reason === 'conflicting_initial_values'));
  const species = recordsOf({ records }, 'species')[0];
  assert.equal(species.value.initialKind, 'amount');
  assert.equal(species.value.value, '3');
});

test('未声明初始值的物种标记为 unspecified', () => {
  const bytes = wrap(`
    <listOfCompartments><compartment id="c1" constant="true"/></listOfCompartments>
    <listOfSpecies><species id="s1" compartment="c1" constant="false" hasOnlySubstanceUnits="false" boundaryCondition="false"/></listOfSpecies>`);
  const { records, issues } = interpretSbml(bytes, RECEIPT);
  assert.deepEqual(issues, []);
  assert.equal(recordsOf({ records }, 'species')[0].value.initialKind, 'unspecified');
});

test('规则与事件登记原文 MathML 并核对变量引用', () => {
  const bytes = wrap(`
    <listOfCompartments><compartment id="c1" constant="true"/></listOfCompartments>
    <listOfSpecies><species id="s1" compartment="c1" initialAmount="1" constant="false" hasOnlySubstanceUnits="true" boundaryCondition="false"/></listOfSpecies>
    <listOfParameters><parameter id="p1" value="2" constant="false"/></listOfParameters>
    <listOfRules>
      <assignmentRule variable="p1"><math xmlns="http://www.w3.org/1998/Math/MathML"><apply><plus/><ci>s1</ci><cn>1</cn></apply></math></assignmentRule>
      <rateRule variable="gone"><math xmlns="http://www.w3.org/1998/Math/MathML"><cn>0</cn></math></rateRule>
    </listOfRules>
    <listOfEvents>
      <event id="e1" useValuesFromTriggerTime="true">
        <trigger><math xmlns="http://www.w3.org/1998/Math/MathML"><apply><gt/><ci>s1</ci><cn>5</cn></apply></math></trigger>
        <listOfEventAssignments>
          <eventAssignment variable="p1"><math xmlns="http://www.w3.org/1998/Math/MathML"><cn>0</cn></math></eventAssignment>
          <eventAssignment variable="lost"><math xmlns="http://www.w3.org/1998/Math/MathML"><cn>1</cn></math></eventAssignment>
        </listOfEventAssignments>
      </event>
    </listOfEvents>`);
  const { records, issues } = interpretSbml(bytes, RECEIPT);
  const rules = recordsOf({ records }, 'rule');
  assert.equal(rules.length, 2);
  assert.equal(rules[0].value.type, 'assignment');
  assert.equal(rules[0].value.variable, 'p1');
  assert.ok(rules[0].value.math.startsWith('<math'));
  assert.ok(rules[0].provenance[0].location.startsWith('bytes:'));
  const events = recordsOf({ records }, 'event');
  assert.equal(events.length, 1);
  assert.equal(events[0].value.assignments.length, 2);
  assert.ok(events[0].value.trigger.math.includes('<gt/>'));
  const unknownVariables = issues.filter(issue => issue.reason === 'unknown_variable_reference').map(issue => issue.detail.variable);
  assert.deepEqual(unknownVariables.sort(), ['gone', 'lost']);
});

test('单位定义建档，未知单位引用记为问题', () => {
  const bytes = wrap(`
    <listOfUnitDefinitions>
      <unitDefinition id="per_sec"><listOfUnits><unit kind="second" exponent="-1" scale="0" multiplier="1"/></listOfUnits></unitDefinition>
    </listOfUnitDefinitions>
    <listOfParameters>
      <parameter id="a" value="1" constant="true" units="per_sec"/>
      <parameter id="b" value="1" constant="true" units="furlong"/>
    </listOfParameters>`);
  const { records, issues } = interpretSbml(bytes, RECEIPT);
  const definition = recordsOf({ records }, 'unitDefinition')[0];
  assert.equal(definition.value.id, 'per_sec');
  assert.deepEqual(definition.value.units, [{ kind: 'second', exponent: '-1', scale: '0', multiplier: '1' }]);
  const unknown = issues.filter(issue => issue.reason === 'unknown_unit_reference');
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].detail.unit, 'furlong');
});

test('扩展命名空间保留原文并标识支持边界，扩展属性同样标识', () => {
  const bytes = Buffer.from(`<?xml version="1.0"?><sbml xmlns="http://www.sbml.org/sbml/level3/version2/core" xmlns:layout="http://www.sbml.org/sbml/level3/version1/layout/version1" layout:required="false" level="3" version="2"><model id="m"><layout:listOfLayouts><layout:layout layout:id="l1"/></layout:listOfLayouts><listOfCompartments><compartment id="c1" constant="true"/></listOfCompartments></model></sbml>`);
  const { records, issues } = interpretSbml(bytes, RECEIPT);
  const extension = recordsOf({ records }, 'extension')[0];
  assert.equal(extension.value.namespace, 'http://www.sbml.org/sbml/level3/version1/layout/version1');
  assert.ok(extension.value.xml.includes('layout:listOfLayouts'));
  assert.ok(extension.value.xml.startsWith('<layout:listOfLayouts'));
  assert.ok(issues.some(issue => issue.reason === 'extension_not_interpreted'));
  assert.ok(issues.some(issue => issue.reason === 'extension_attributes_not_interpreted' && issue.detail.attributes.includes('layout:required')));
  assert.ok(recordsOf({ records }, 'compartment').length === 1);
});

test('拒绝 DTD，未知实体与截断文档各自落成问题而非崩溃', async () => {
  const dtd = Buffer.from('<?xml version="1.0"?><!DOCTYPE sbml [<!ENTITY x "1">]><sbml xmlns="http://www.sbml.org/sbml/level3/version2/core"/>');
  const dtdResult = interpretSbml(dtd, RECEIPT);
  assert.equal(dtdResult.records.length, 0);
  assert.equal(dtdResult.issues[0].reason, 'xml_not_well_formed');
  assert.equal(dtdResult.issues[0].detail.syntax, 'dtd_not_allowed');

  const entity = wrap('<listOfCompartments><compartment id="c&amp;#x31;" constant="true"/></listOfCompartments>');
  assert.deepEqual(interpretSbml(entity, RECEIPT).issues, []);
  const badEntity = Buffer.from('<?xml version="1.0"?><sbml xmlns="http://www.sbml.org/sbml/level3/version2/core"><model id="m" name="a&b;"/></sbml>');
  assert.equal(interpretSbml(badEntity, RECEIPT).issues[0].detail.syntax, 'undefined_entity');

  const partial = await readFile(new URL('../fixtures/model.xml.partial', import.meta.url));
  const partialResult = interpretSbml(partial, RECEIPT);
  // 截断文档整体不解释：记录为零，问题单指出精确的截断位置，原文由收件保留。
  assert.equal(partialResult.records.length, 0);
  assert.equal(partialResult.issues.at(-1).reason, 'xml_not_well_formed');
  assert.match(partialResult.issues.at(-1).location, /^bytes:\d+$/);
  const offset = Number(partialResult.issues.at(-1).location.slice('bytes:'.length));
  assert.ok(offset > partial.length - 10 && offset <= partial.length, '问题定位应指向截断点附近');
});

test('非 core 命名空间的 sbml 根记为支持边界问题', () => {
  const bytes = Buffer.from('<?xml version="1.0"?><sbml xmlns="http://www.sbml.org/sbml/level2/version4" level="2" version="4"><model id="m"/></sbml>');
  const { issues } = interpretSbml(bytes, RECEIPT);
  assert.ok(issues.some(issue => issue.reason === 'unsupported_sbml_namespace'));
});

test('解释结果入库：同键同值幂等合并出处，修订分歧不覆盖已归档记录', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'archive-'));
  try {
    const archive = new Archive(directory);
    await archive.initialize();
    const first = await archive.receive({ collectionId: 'c', sourceKey: 'src', revision: 'r1', mediaType: 'application/xml', bytes: fixture, summary: {} });
    const second = await archive.receive({ collectionId: 'c', sourceKey: 'src', revision: 'r2', mediaType: 'application/xml', bytes: fixture, summary: {} });
    assert.notEqual(first.receiptId, second.receiptId);

    const v1 = interpretSbml(fixture, first.receiptId);
    await archive.applyInterpretation('c', v1);
    const again = interpretSbml(fixture, second.receiptId);
    await archive.applyInterpretation('c', again);
    let collection = await archive.collection('c');
    const species = collection.records.filter(record => record.kind === 'species');
    assert.equal(species.length, 2, '重复解释不产生重复记录');
    assert.equal(species[0].provenance.length, 2, '两个修订的出处合并到同一记录');
    assert.equal(collection.issues.length, 0);

    const changed = Buffer.from(fixture.toString('utf8').replace('initialAmount="2"', 'initialAmount="7"'));
    const third = await archive.receive({ collectionId: 'c', sourceKey: 'src', revision: 'r3', mediaType: 'application/xml', bytes: changed, summary: {} });
    await archive.applyInterpretation('c', interpretSbml(changed, third.receiptId));
    collection = await archive.collection('c');
    const s2 = collection.records.find(record => record.kind === 'species' && record.key === 'S2');
    assert.equal(s2.value.value, '2', '已归档记录不被新修订覆盖');
    const conflict = collection.issues.find(issue => issue.reason === 'record_identity_conflict' && issue.detail.key === 'S2');
    assert.ok(conflict, '分歧必须落成问题');
    assert.equal(conflict.receiptId, third.receiptId);
    assert.equal((await archive.body(third.receiptId)).toString('utf8'), changed.toString('utf8'), '历次修订原文均可回查');
    assert.equal((await archive.body(first.receiptId)).toString('utf8'), fixture.toString('utf8'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
