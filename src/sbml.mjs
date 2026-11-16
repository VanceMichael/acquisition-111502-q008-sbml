// SBML L3V2 core 声明解释：把已收件的原始字节转成可回查的结构化记录。
// 只登记声明与交叉核对引用，不执行数学；MathML 按原文保留。
// 物种身份 = SBML id（同名不同隔室是不同对象）；局部参数与全局参数分别建档，互不覆盖。
// 初始浓度与初始物质量按交付原值保存，不做换算。

import { parseXmlDocument, resolveNamespaces, elementChildren, decodeText, XmlSyntaxError } from './xml.mjs';

export const CORE_NAMESPACE = 'http://www.sbml.org/sbml/level3/version2/core';
export const MATHML_NAMESPACE = 'http://www.w3.org/1998/Math/MathML';

// SBML L3 core 内置单位名；其余单位引用必须指向模型内声明的 unitDefinition。
const BASE_UNITS = new Set([
  'ampere', 'avogadro', 'becquerel', 'candela', 'coulomb', 'dimensionless', 'farad', 'gram',
  'gray', 'henry', 'hertz', 'item', 'joule', 'katal', 'kelvin', 'kilogram', 'litre', 'liter',
  'lumen', 'lux', 'metre', 'meter', 'mole', 'newton', 'ohm', 'pascal', 'radian', 'second',
  'siemens', 'sievert', 'steradian', 'tesla', 'volt', 'watt', 'weber'
]);

// core 定义的可含任意内容的文档性容器，不参与语义解释，也不按扩展处理。
const DOCUMENTATION_ELEMENTS = new Set(['notes', 'annotation']);

export function interpretSbml(bytes, receiptId) {
  const records = [];
  const issues = [];

  const locationOf = node => `bytes:${node.start}-${node.end}`;
  const provenanceOf = node => [{ receiptId, location: locationOf(node) }];
  const raise = (reason, node, detail) => {
    const issue = { reason, location: typeof node === 'string' ? node : locationOf(node), receiptId };
    if (detail !== undefined) issue.detail = detail;
    issues.push(issue);
  };

  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    raise('invalid_utf8', 'bytes:0');
    return { records, issues };
  }

  let root;
  try {
    root = resolveNamespaces(parseXmlDocument(text));
  } catch (error) {
    if (error instanceof XmlSyntaxError) {
      raise('xml_not_well_formed', `bytes:${error.offset}`, { syntax: error.syntax });
      return { records, issues };
    }
    throw error;
  }

  // 原文片段用于 MathML 与扩展保留；字节区间与 receipt 正文一一对应，可回查。
  const raw = node => bytes.subarray(node.start, node.end).toString('utf8');

  if (root.local !== 'sbml') {
    raise('root_not_sbml', root, { element: root.name });
    return { records, issues };
  }
  if (root.ns !== CORE_NAMESPACE) {
    raise('unsupported_sbml_namespace', root, { namespace: root.ns });
  }

  // 未知命名空间扩展：保留原文并记录支持边界，不假称已解释。
  function flagExtensions(node, insideDocumentation) {
    if (!Object.hasOwn(node, 'name')) return;
    const isDocumentation = node.ns === CORE_NAMESPACE && DOCUMENTATION_ELEMENTS.has(node.local);
    if (isDocumentation) return;
    const foreign = node.ns !== null && node.ns !== CORE_NAMESPACE && node.ns !== MATHML_NAMESPACE;
    if (foreign && !insideDocumentation) {
      records.push({
        kind: 'extension',
        key: `extension:${records.filter(record => record.kind === 'extension').length}`,
        value: { namespace: node.ns, element: node.local, xml: raw(node) },
        provenance: provenanceOf(node)
      });
      raise('extension_not_interpreted', node, { namespace: node.ns, element: node.local });
      return;
    }
    const foreignAttributes = node.attributes.filter(attribute =>
      attribute.ns !== null && attribute.ns !== CORE_NAMESPACE &&
      attribute.ns !== 'http://www.w3.org/2000/xmlns/' && attribute.ns !== 'http://www.w3.org/XML/1998/namespace');
    if (foreignAttributes.length > 0 && node.ns === CORE_NAMESPACE) {
      raise('extension_attributes_not_interpreted', node, {
        element: node.local, attributes: foreignAttributes.map(attribute => attribute.name)
      });
    }
    for (const child of elementChildren(node)) flagExtensions(child, false);
  }
  flagExtensions(root, false);

  const models = elementChildren(root).filter(child => child.ns === CORE_NAMESPACE && child.local === 'model');
  if (models.length === 0) raise('missing_model', root);
  for (const extra of models.slice(1)) raise('multiple_models', extra);
  for (const child of elementChildren(root)) {
    if (child.ns === CORE_NAMESPACE && child.local !== 'model' && !DOCUMENTATION_ELEMENTS.has(child.local)) {
      raise('element_not_interpreted', child, { element: child.local });
    }
  }
  if (models.length === 0) return { records, issues };
  const model = models[0];

  const attributesOf = node => {
    const values = {};
    for (const attribute of node.attributes) {
      if (attribute.prefix === null && attribute.name !== 'xmlns') values[attribute.name] = attribute.value;
    }
    return values;
  };

  const modelAttributes = attributesOf(model);
  const sbmlAttributes = attributesOf(root);
  const modelValue = { id: modelAttributes.id ?? null };
  for (const optional of ['name', 'substanceUnits', 'timeUnits', 'extentUnits', 'volumeUnits', 'areaUnits', 'lengthUnits', 'conversionFactor']) {
    if (modelAttributes[optional] !== undefined) modelValue[optional] = modelAttributes[optional];
  }
  if (sbmlAttributes.level !== undefined) modelValue.sbmlLevel = sbmlAttributes.level;
  if (sbmlAttributes.version !== undefined) modelValue.sbmlVersion = sbmlAttributes.version;
  records.push({ kind: 'model', key: modelAttributes.id ?? '(unnamed-model)', value: modelValue, provenance: provenanceOf(model) });

  // 交叉核对登记表。
  const compartments = new Map();
  const speciesById = new Map();
  const modelParameters = new Map();
  const unitDefinitions = new Map();
  const allModelIds = new Map();
  const localParametersByReaction = new Map();
  const pendingSpeciesReferences = [];
  const pendingCompartmentReferences = [];
  const pendingVariableReferences = [];
  const pendingParameterReferences = [];
  const pendingUnitReferences = [];
  const pendingMathScopes = [];

  function registerId(id, node) {
    if (allModelIds.has(id)) {
      raise('duplicate_identifier', node, { id });
      return false;
    }
    allModelIds.set(id, node);
    return true;
  }

  function coreChildren(node, local) {
    return elementChildren(node).filter(child => child.ns === CORE_NAMESPACE && child.local === local);
  }

  function mathElementOf(node) {
    return elementChildren(node).find(child => child.ns === MATHML_NAMESPACE && child.local === 'math') ?? null;
  }

  function collectMath(mathNode, scope) {
    const references = [];
    function walk(element) {
      if (element.ns === MATHML_NAMESPACE && element.local === 'ci') {
        references.push({ name: decodeText(element).trim(), node: element });
      }
      for (const child of elementChildren(element)) walk(child);
    }
    walk(mathNode);
    pendingMathScopes.push({ mathNode, references, scope });
    return raw(mathNode);
  }

  function interpretCompartment(node) {
    const attributes = attributesOf(node);
    if (attributes.id === undefined) { raise('missing_identifier', node, { element: 'compartment' }); return; }
    if (!registerId(attributes.id, node)) return;
    compartments.set(attributes.id, node);
    const value = { id: attributes.id };
    for (const optional of ['name', 'size', 'constant', 'units', 'spatialDimensions']) {
      if (attributes[optional] !== undefined) value[optional] = attributes[optional];
    }
    if (attributes.units !== undefined) pendingUnitReferences.push({ node, unit: attributes.units, attribute: 'units' });
    records.push({ kind: 'compartment', key: attributes.id, value, provenance: provenanceOf(node) });
  }

  function interpretSpecies(node) {
    const attributes = attributesOf(node);
    if (attributes.id === undefined) { raise('missing_identifier', node, { element: 'species' }); return; }
    if (!registerId(attributes.id, node)) return;
    speciesById.set(attributes.id, node);
    const value = { id: attributes.id };
    if (attributes.name !== undefined) value.name = attributes.name;
    if (attributes.compartment !== undefined) {
      value.compartment = attributes.compartment;
      pendingCompartmentReferences.push({ node, compartment: attributes.compartment });
    } else {
      raise('missing_compartment', node, { species: attributes.id });
    }
    // 初始值按交付原样保存：initialAmount 与 initialConcentration 不互相换算。
    if (attributes.initialAmount !== undefined && attributes.initialConcentration !== undefined) {
      raise('conflicting_initial_values', node, { species: attributes.id });
      value.initialKind = 'amount';
      value.value = attributes.initialAmount;
    } else if (attributes.initialAmount !== undefined) {
      value.initialKind = 'amount';
      value.value = attributes.initialAmount;
    } else if (attributes.initialConcentration !== undefined) {
      value.initialKind = 'concentration';
      value.value = attributes.initialConcentration;
    } else {
      value.initialKind = 'unspecified';
    }
    for (const optional of ['hasOnlySubstanceUnits', 'boundaryCondition', 'constant', 'substanceUnits', 'conversionFactor']) {
      if (attributes[optional] !== undefined) value[optional] = attributes[optional];
    }
    if (attributes.substanceUnits !== undefined) pendingUnitReferences.push({ node, unit: attributes.substanceUnits, attribute: 'substanceUnits' });
    if (attributes.conversionFactor !== undefined) pendingParameterReferences.push({ node, parameter: attributes.conversionFactor, attribute: 'conversionFactor' });
    records.push({ kind: 'species', key: attributes.id, value, provenance: provenanceOf(node) });
  }

  function interpretModelParameter(node) {
    const attributes = attributesOf(node);
    if (attributes.id === undefined) { raise('missing_identifier', node, { element: 'parameter' }); return; }
    if (!registerId(attributes.id, node)) return;
    modelParameters.set(attributes.id, node);
    const value = { id: attributes.id, scope: 'model' };
    for (const optional of ['name', 'value', 'constant', 'units']) {
      if (attributes[optional] !== undefined) value[optional] = attributes[optional];
    }
    if (attributes.units !== undefined) pendingUnitReferences.push({ node, unit: attributes.units, attribute: 'units' });
    records.push({ kind: 'parameter', key: `model/${attributes.id}`, value, provenance: provenanceOf(node) });
  }

  function interpretUnitDefinition(node) {
    const attributes = attributesOf(node);
    if (attributes.id === undefined) { raise('missing_identifier', node, { element: 'unitDefinition' }); return; }
    if (unitDefinitions.has(attributes.id)) { raise('duplicate_identifier', node, { id: attributes.id }); return; }
    unitDefinitions.set(attributes.id, node);
    const value = { id: attributes.id, units: [] };
    if (attributes.name !== undefined) value.name = attributes.name;
    for (const list of coreChildren(node, 'listOfUnits')) {
      for (const unit of coreChildren(list, 'unit')) {
        const unitAttributes = attributesOf(unit);
        const entry = {};
        for (const field of ['kind', 'exponent', 'scale', 'multiplier']) {
          if (unitAttributes[field] !== undefined) entry[field] = unitAttributes[field];
        }
        if (unitAttributes.kind !== undefined && !BASE_UNITS.has(unitAttributes.kind)) {
          raise('unknown_unit_kind', unit, { kind: unitAttributes.kind });
        }
        value.units.push(entry);
      }
    }
    records.push({ kind: 'unitDefinition', key: attributes.id, value, provenance: provenanceOf(node) });
  }

  function interpretSpeciesReference(node, role) {
    const attributes = attributesOf(node);
    const entry = {};
    if (attributes.species !== undefined) {
      entry.species = attributes.species;
      pendingSpeciesReferences.push({ node, species: attributes.species });
    } else {
      raise('missing_species_reference', node, { role });
    }
    for (const optional of ['id', 'name', 'stoichiometry', 'constant']) {
      if (attributes[optional] !== undefined) entry[optional] = attributes[optional];
    }
    if (attributes.id !== undefined) registerId(attributes.id, node);
    return entry;
  }

  function interpretReaction(node) {
    const attributes = attributesOf(node);
    if (attributes.id === undefined) { raise('missing_identifier', node, { element: 'reaction' }); return; }
    if (!registerId(attributes.id, node)) return;
    const reactionId = attributes.id;
    const value = { id: reactionId };
    for (const optional of ['name', 'reversible', 'fast', 'compartment']) {
      if (attributes[optional] !== undefined) value[optional] = attributes[optional];
    }
    if (attributes.compartment !== undefined) pendingCompartmentReferences.push({ node, compartment: attributes.compartment });
    value.reactants = [];
    value.products = [];
    value.modifiers = [];
    const localIds = new Set();
    localParametersByReaction.set(reactionId, localIds);
    for (const child of elementChildren(node)) {
      if (child.ns !== CORE_NAMESPACE) continue;
      if (child.local === 'listOfReactants') {
        for (const reference of coreChildren(child, 'speciesReference')) value.reactants.push(interpretSpeciesReference(reference, 'reactant'));
      } else if (child.local === 'listOfProducts') {
        for (const reference of coreChildren(child, 'speciesReference')) value.products.push(interpretSpeciesReference(reference, 'product'));
      } else if (child.local === 'listOfModifiers') {
        for (const reference of coreChildren(child, 'modifierSpeciesReference')) value.modifiers.push(interpretSpeciesReference(reference, 'modifier'));
      } else if (child.local === 'kineticLaw') {
        const mathNode = mathElementOf(child);
        if (mathNode) value.math = collectMath(mathNode, { reaction: reactionId });
        else raise('missing_math', child, { element: 'kineticLaw' });
        for (const list of coreChildren(child, 'listOfLocalParameters')) {
          for (const local of coreChildren(list, 'localParameter')) {
            const localAttributes = attributesOf(local);
            if (localAttributes.id === undefined) { raise('missing_identifier', local, { element: 'localParameter' }); continue; }
            if (localIds.has(localAttributes.id)) { raise('duplicate_identifier', local, { id: localAttributes.id }); continue; }
            localIds.add(localAttributes.id);
            // 局部参数只挂在所属反应的作用域下，与同名全局参数各自独立建档。
            const localValue = { id: localAttributes.id, scope: `reaction:${reactionId}` };
            for (const optional of ['name', 'value', 'units']) {
              if (localAttributes[optional] !== undefined) localValue[optional] = localAttributes[optional];
            }
            if (localAttributes.units !== undefined) pendingUnitReferences.push({ node: local, unit: localAttributes.units, attribute: 'units' });
            records.push({ kind: 'parameter', key: `reaction:${reactionId}/${localAttributes.id}`, value: localValue, provenance: provenanceOf(local) });
          }
        }
      } else if (!DOCUMENTATION_ELEMENTS.has(child.local) && child.local !== 'listOfReactants' && child.local !== 'listOfProducts' && child.local !== 'listOfModifiers') {
        raise('element_not_interpreted', child, { element: child.local });
      }
    }
    records.push({ kind: 'reaction', key: reactionId, value, provenance: provenanceOf(node) });
  }

  const RULE_TYPES = { algebraicRule: 'algebraic', assignmentRule: 'assignment', rateRule: 'rate' };

  function interpretRule(node, index) {
    const attributes = attributesOf(node);
    const type = RULE_TYPES[node.local];
    const value = { type };
    if (attributes.variable !== undefined) {
      value.variable = attributes.variable;
      pendingVariableReferences.push({ node, variable: attributes.variable });
    } else if (type !== 'algebraic') {
      raise('missing_variable', node, { element: node.local });
    }
    const mathNode = mathElementOf(node);
    if (mathNode) value.math = collectMath(mathNode, { reaction: null });
    else raise('missing_math', node, { element: node.local });
    const key = attributes.variable !== undefined ? `${node.local}:${attributes.variable}` : `${node.local}:${index}`;
    records.push({ kind: 'rule', key, value, provenance: provenanceOf(node) });
  }

  function interpretEvent(node, index) {
    const attributes = attributesOf(node);
    const value = {};
    if (attributes.id !== undefined) {
      value.id = attributes.id;
      registerId(attributes.id, node);
    }
    for (const optional of ['name', 'useValuesFromTriggerTime']) {
      if (attributes[optional] !== undefined) value[optional] = attributes[optional];
    }
    value.assignments = [];
    let hasTrigger = false;
    for (const child of elementChildren(node)) {
      if (child.ns !== CORE_NAMESPACE) continue;
      if (child.local === 'trigger' || child.local === 'delay' || child.local === 'priority') {
        if (child.local === 'trigger') hasTrigger = true;
        const mathNode = mathElementOf(child);
        if (mathNode) value[child.local] = { math: collectMath(mathNode, { reaction: null }) };
        else raise('missing_math', child, { element: child.local });
      } else if (child.local === 'listOfEventAssignments') {
        for (const assignment of coreChildren(child, 'eventAssignment')) {
          const assignmentAttributes = attributesOf(assignment);
          const entry = {};
          if (assignmentAttributes.variable !== undefined) {
            entry.variable = assignmentAttributes.variable;
            pendingVariableReferences.push({ node: assignment, variable: assignmentAttributes.variable });
          } else {
            raise('missing_variable', assignment, { element: 'eventAssignment' });
          }
          const mathNode = mathElementOf(assignment);
          if (mathNode) entry.math = collectMath(mathNode, { reaction: null });
          else raise('missing_math', assignment, { element: 'eventAssignment' });
          value.assignments.push(entry);
        }
      } else if (!DOCUMENTATION_ELEMENTS.has(child.local)) {
        raise('element_not_interpreted', child, { element: child.local });
      }
    }
    if (!hasTrigger) raise('event_without_trigger', node, { event: value.id ?? null });
    records.push({ kind: 'event', key: value.id ?? `event:${index}`, value, provenance: provenanceOf(node) });
  }

  const LIST_HANDLERS = {
    listOfCompartments: ['compartment', interpretCompartment],
    listOfSpecies: ['species', interpretSpecies],
    listOfParameters: ['parameter', interpretModelParameter],
    listOfUnitDefinitions: ['unitDefinition', interpretUnitDefinition],
    listOfReactions: ['reaction', interpretReaction]
  };

  let ruleIndex = 0;
  let eventIndex = 0;
  for (const child of elementChildren(model)) {
    if (child.ns !== CORE_NAMESPACE) continue;
    if (LIST_HANDLERS[child.local]) {
      const [elementName, handler] = LIST_HANDLERS[child.local];
      for (const item of coreChildren(child, elementName)) handler(item);
    } else if (child.local === 'listOfRules') {
      for (const rule of elementChildren(child)) {
        if (rule.ns === CORE_NAMESPACE && RULE_TYPES[rule.local]) interpretRule(rule, ruleIndex++);
        else if (rule.ns === CORE_NAMESPACE) raise('element_not_interpreted', rule, { element: rule.local });
      }
    } else if (child.local === 'listOfEvents') {
      for (const event of coreChildren(child, 'event')) interpretEvent(event, eventIndex++);
    } else if (!DOCUMENTATION_ELEMENTS.has(child.local)) {
      // 未列入支持范围的标准元素（如 initialAssignment、constraint、functionDefinition）：
      // 明确标识未解释，原文仍在收件字节中可查。
      raise('element_not_interpreted', child, { element: child.local });
    }
  }

  // 交叉核对：所有引用必须能回到已声明对象；核对不上的一律记为未决问题，不静默丢弃。
  for (const { node, compartment } of pendingCompartmentReferences) {
    if (!compartments.has(compartment)) raise('unknown_compartment_reference', node, { compartment });
  }
  for (const { node, species } of pendingSpeciesReferences) {
    if (!speciesById.has(species)) raise('unknown_species_reference', node, { species });
  }
  for (const { node, variable } of pendingVariableReferences) {
    if (!allModelIds.has(variable)) raise('unknown_variable_reference', node, { variable });
  }
  for (const { node, parameter } of pendingParameterReferences) {
    if (!modelParameters.has(parameter)) raise('unknown_parameter_reference', node, { parameter });
  }
  for (const { node, unit, attribute } of pendingUnitReferences) {
    if (!BASE_UNITS.has(unit) && !unitDefinitions.has(unit)) raise('unknown_unit_reference', node, { unit, attribute });
  }
  for (const { references, scope } of pendingMathScopes) {
    const localIds = scope.reaction ? localParametersByReaction.get(scope.reaction) ?? new Set() : new Set();
    for (const reference of references) {
      if (reference.name.length === 0) { raise('empty_math_reference', reference.node); continue; }
      // 反应内数学引用先解析到该反应的局部参数，再解析到模型级对象；两种记录都已分别建档。
      if (!localIds.has(reference.name) && !allModelIds.has(reference.name)) {
        raise('unresolved_math_reference', reference.node, { reference: reference.name });
      }
    }
  }

  return { records, issues };
}
