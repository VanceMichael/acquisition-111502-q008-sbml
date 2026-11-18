// SBML Level 3 Version 2 core 的资料解释器。
// 只声明、核对与登记资料，不执行任何数学；MathML 按原始字节保留。
// 同名物种（不同 id 或不同隔室）与同名的全局/局部参数都保持为不同对象，
// 解释器不会把它们合并，也不会把局部参数当作全局参数覆盖。

import { parseXml, XmlParser, childElements, findChild, attribute, textOf } from './xml.mjs';

export const SBML_NS = 'http://www.sbml.org/sbml/level3/version2/core';
export const MATHML_NS = 'http://www.w3.org/1998/Math/MathML';
const MATHML_NS_OLD = 'http://www.w3.org/1998/Math/MathML2';

// SBML L3 内置单位；未声明即可引用。
const BUILTIN_UNITS = new Set([
  'ampere', 'avogadro', 'becquerel', 'candela', 'coulomb', 'dimensionless', 'farad', 'gram',
  'gray', 'henry', 'hertz', 'joule', 'katal', 'kelvin', 'kilogram', 'litre', 'lumen', 'lux',
  'metre', 'mole', 'newton', 'ohm', 'pascal', 'radian', 'second', 'siemens', 'sievert',
  'steradian', 'tesla', 'volt', 'watt', 'weber',
  // SBML 允许的美式拼写别名
  'liter', 'meter'
]);

const PACKAGE_NAMESPACE_PATTERN = /^http:\/\/www\.sbml\.org\/sbml\/level3\/version\d+\/([a-z][a-z0-9]*)\/version\d+$/;
function loc(elementOrLocation, end = null) {
  const location = elementOrLocation?.location ?? elementOrLocation;
  const target = end ? { ...location, byteEnd: end } : location;
  return XmlParser.formatLocation(target);
}

function mathNamespaces(element) {
  const declared = element?.attributes.filter(candidate => candidate.name.startsWith('xmlns'))
    .map(candidate => ({ name: candidate.name, value: candidate.value })) ?? [];
  return declared;
}

// 收集 MathML 子树中的 ci/csymbol 引用；不做求值，只做身份核对。
function collectMathReferences(element, references = []) {
  if (!element) return references;
  for (const child of element.children ?? []) {
    if (child.type !== 'element') continue;
    if ((child.namespaceUri === MATHML_NS || child.namespaceUri === MATHML_NS_OLD) && child.localName === 'ci') {
      references.push({ symbol: textOf(child).trim(), element: child, kind: 'ci' });
    } else if (child.namespaceUri === MATHML_NS && child.localName === 'csymbol') {
      references.push({ symbol: textOf(child).trim(), element: child, kind: 'csymbol', encoding: attribute(child, 'encoding')?.value });
    }
    collectMathReferences(child, references);
  }
  return references;
}

function rawMathml(mathElement, bytes) {
  if (!mathElement) return null;
  const start = mathElement.location.byteStart;
  const end = mathElement.location.byteEnd;
  return {
    mathml: bytes.toString('utf8', start, end),
    location: loc(mathElement),
    byteStart: start,
    byteEnd: end,
    declaredNamespaces: mathNamespaces(mathElement)
  };
}

function extensionKind(namespaceUri) {
  const packageMatch = namespaceUri?.match(PACKAGE_NAMESPACE_PATTERN);
  if (packageMatch) return { packageName: packageMatch[1], type: 'sbml-package' };
  return { packageName: null, type: 'foreign-namespace' };
}

export function interpretSbml(bytes, { receiptId, sourceKey } = {}) {
  const { root, issues: xmlIssues } = parseXml(bytes, { lenient: true });
  const records = [];
  const issues = xmlIssues.map(issue => ({ reason: issue.reason, location: XmlParser.formatLocation(issue.location), receiptId }));
  const pushIssue = (reason, elementOrLocation, detail = {}) => {
    issues.push({ reason, location: loc(elementOrLocation), receiptId, ...detail });
  };
  const pushRecord = (kind, key, value, element, extraLocation = null) => {
    const provenance = [{ receiptId, location: extraLocation ?? loc(element) }];
    records.push({ kind, key, value, provenance });
  };

  if (!root) {
    pushIssue('sbml_document_unavailable', { location: { byteStart: 0, byteEnd: bytes.length, line: 1, column: 1 } });
    return { records, issues };
  }
  if (root.localName !== 'sbml' || root.namespaceUri !== SBML_NS) {
    pushIssue('sbml_root_namespace_unexpected', root, { namespaceUri: root.namespaceUri ?? null });
  }

  const level = attribute(root, 'level')?.value ?? null;
  const version = attribute(root, 'version')?.value ?? null;
  if (level !== '3' || version !== '2') {
    pushIssue('sbml_level_version_unexpected', root, { level, version, supported: '3.2' });
  }

  // 根上的扩展包命名空间：显式标识支持边界，不假称已解释。
  const packageRequired = new Map();
  for (const declared of root.attributes.filter(candidate => candidate.name.startsWith('xmlns:'))) {
    const prefix = declared.name.slice(6);
    const info = extensionKind(declared.value);
    if (info.type === 'sbml-package') {
      const requiredAttr = root.attributes.find(candidate => candidate.name === `${prefix}:required`);
      packageRequired.set(info.packageName, requiredAttr?.value ?? null);
      pushRecord('extension', `package:${info.packageName}`, {
        packageName: info.packageName,
        namespaceUri: declared.value,
        prefix,
        required: requiredAttr?.value ?? null,
        supported: false,
        supportBoundary: '未列出的标准扩展包：命名空间与 required 已登记，包内语义未解释'
      }, declared, loc(declared.location));
      pushIssue('sbml_package_unsupported', declared.location, {
        packageName: info.packageName,
        required: requiredAttr?.value ?? null,
        scope: '整个 SBML 文档中该命名空间下的构造'
      });
    } else if (declared.value !== MATHML_NS && declared.value !== MATHML_NS_OLD
      && declared.value !== 'http://www.w3.org/XML/1998/namespace') {
      pushIssue('sbml_foreign_namespace_unsupported', declared.location, { namespaceUri: declared.value, prefix });
    }
  }

  const model = findChild(root, 'model', SBML_NS);
  if (!model) {
    pushIssue('sbml_model_missing', root);
    return { records, issues };
  }
  const modelId = attribute(model, 'id')?.value ?? null;
  pushRecord('model', modelId ?? 'model', {
    id: modelId,
    name: attribute(model, 'name')?.value ?? null,
    level,
    version
  }, model);

  const declaredIds = new Map();
  const registerId = (id, element, kind) => {
    if (!id) return;
    if (declaredIds.has(id)) pushIssue('sbml_duplicate_id', element, { id, kind, firstKind: declaredIds.get(id) });
    else declaredIds.set(id, kind);
  };
  const knownUnit = unitId => BUILTIN_UNITS.has(unitId) || declaredIds.get(unitId) === 'unitDefinition';

  // 单位定义：保留 kind、exponent、scale、multiplier 原值，并登记自定义单位身份。
  const listOfUnits = findChild(model, 'listOfUnitDefinitions', SBML_NS);
  for (const unitDefinition of childElements(listOfUnits, 'unitDefinition', SBML_NS)) {
    const id = attribute(unitDefinition, 'id')?.value ?? null;
    registerId(id, unitDefinition, 'unitDefinition');
    const units = childElements(findChild(unitDefinition, 'listOfUnits', SBML_NS), 'unit', SBML_NS).map(unit => ({
      kind: attribute(unit, 'kind')?.value ?? null,
      exponent: attribute(unit, 'exponent')?.value ?? null,
      scale: attribute(unit, 'scale')?.value ?? null,
      multiplier: attribute(unit, 'multiplier')?.value ?? null
    }));
    for (const unit of childElements(findChild(unitDefinition, 'listOfUnits', SBML_NS), 'unit', SBML_NS)) {
      const kind = attribute(unit, 'kind')?.value;
      if (kind && !BUILTIN_UNITS.has(kind)) pushIssue('sbml_unit_kind_unknown', unit, { kind });
    }
    pushRecord('unitDefinition', id, { id, name: attribute(unitDefinition, 'name')?.value ?? null, units }, unitDefinition);
  }

  // 隔室：size 按原值保存，不做换算。
  const compartments = new Map();
  for (const compartment of childElements(findChild(model, 'listOfCompartments', SBML_NS), 'compartment', SBML_NS)) {
    const id = attribute(compartment, 'id')?.value ?? null;
    registerId(id, compartment, 'compartment');
    compartments.set(id, compartment);
    const outside = attribute(compartment, 'outside')?.value ?? null;
    if (outside && ![...childElements(findChild(model, 'listOfCompartments', SBML_NS), 'compartment', SBML_NS)].some(other => attribute(other, 'id')?.value === outside)) {
      pushIssue('sbml_compartment_outside_unknown', compartment, { outside });
    }
    const compartmentUnits = attribute(compartment, 'units');
    if (compartmentUnits && !knownUnit(compartmentUnits.value)) {
      pushIssue('sbml_unit_reference_unknown', compartmentUnits.location, { unitId: compartmentUnits.value, holder: id });
    }
    pushRecord('compartment', id, {
      id,
      name: attribute(compartment, 'name')?.value ?? null,
      size: attribute(compartment, 'size')?.value ?? null,
      spatialDimensions: attribute(compartment, 'spatialDimensions')?.value ?? null,
      units: attribute(compartment, 'units')?.value ?? null,
      constant: attribute(compartment, 'constant')?.value ?? null,
      outside
    }, compartment);
  }

  // 物种：初始浓度/初始物质量分别是什么就保存什么，绝不互相换算。
  const species = new Map();
  const speciesNames = new Map();
  for (const speciesElement of childElements(findChild(model, 'listOfSpecies', SBML_NS), 'species', SBML_NS)) {
    const id = attribute(speciesElement, 'id')?.value ?? null;
    registerId(id, speciesElement, 'species');
    const compartmentId = attribute(speciesElement, 'compartment')?.value ?? null;
    if (!compartments.has(compartmentId)) pushIssue('sbml_species_compartment_unknown', speciesElement, { speciesId: id, compartment: compartmentId });
    const initialConcentration = attribute(speciesElement, 'initialConcentration')?.value;
    const initialAmount = attribute(speciesElement, 'initialAmount')?.value;
    let initialKind = 'unspecified';
    if (initialConcentration !== undefined && initialAmount !== undefined) {
      pushIssue('sbml_species_initial_conflict', speciesElement, { speciesId: id });
      initialKind = 'amount-and-concentration';
    } else if (initialConcentration !== undefined) initialKind = 'concentration';
    else if (initialAmount !== undefined) initialKind = 'amount';
    const units = attribute(speciesElement, 'substanceUnits')?.value;
    if (units && !knownUnit(units)) pushIssue('sbml_unit_reference_unknown', speciesElement, { unitId: units, holder: id });
    const name = attribute(speciesElement, 'name')?.value ?? null;
    if (name) {
      if (!speciesNames.has(name)) speciesNames.set(name, []);
      speciesNames.get(name).push(id);
    }
    const value = {
      id,
      name,
      compartment: compartmentId,
      initialKind,
      initialConcentration: initialConcentration ?? null,
      initialAmount: initialAmount ?? null,
      substanceUnits: units ?? null,
      hasOnlySubstanceUnits: attribute(speciesElement, 'hasOnlySubstanceUnits')?.value ?? null,
      boundaryCondition: attribute(speciesElement, 'boundaryCondition')?.value ?? null,
      constant: attribute(speciesElement, 'constant')?.value ?? null
    };
    species.set(id, { element: speciesElement, value });
    pushRecord('species', id, value, speciesElement);
  }
  // 同名不等于同一对象：仅作提示性核对，不合并、不改写。
  for (const [name, ids] of speciesNames) if (ids.length > 1) pushIssue('sbml_species_shared_name', model, { name, speciesIds: ids });

  // 全局参数：scope=model，与反应内局部参数分别保存。
  const globalParameters = new Map();
  for (const parameter of childElements(findChild(model, 'listOfParameters', SBML_NS), 'parameter', SBML_NS)) {
    const id = attribute(parameter, 'id')?.value ?? null;
    registerId(id, parameter, 'parameter');
    const units = attribute(parameter, 'units')?.value;
    if (units && !knownUnit(units)) pushIssue('sbml_unit_reference_unknown', parameter, { unitId: units, holder: id });
    globalParameters.set(id, parameter);
    pushRecord('parameter', `model:${id}`, {
      id,
      name: attribute(parameter, 'name')?.value ?? null,
      scope: 'model',
      value: attribute(parameter, 'value')?.value ?? null,
      units: units ?? null,
      constant: attribute(parameter, 'constant')?.value ?? null
    }, parameter);
  }

  const functionDefinitions = new Set(childElements(findChild(model, 'listOfFunctionDefinitions', SBML_NS), 'functionDefinition', SBML_NS)
    .map(element => attribute(element, 'id')?.value).filter(Boolean));

  const resolveSymbol = (symbol, reactionId, localParameters) => {
    if (localParameters.has(symbol)) return { scope: `reaction:${reactionId}`, kind: 'localParameter' };
    if (globalParameters.has(symbol)) return { scope: 'model', kind: 'parameter' };
    if (species.has(symbol)) return { scope: 'model', kind: 'species' };
    if (compartments.has(symbol)) return { scope: 'model', kind: 'compartment' };
    if (functionDefinitions.has(symbol)) return { scope: 'model', kind: 'functionDefinition' };
    return null;
  };

  // 反应、参与者、动力学定律中的局部参数与原始 MathML。
  const reactions = childElements(findChild(model, 'listOfReactions', SBML_NS), 'reaction', SBML_NS);
  for (const reaction of reactions) {
    const reactionId = attribute(reaction, 'id')?.value ?? null;
    registerId(reactionId, reaction, 'reaction');
    const participants = [];
    for (const [role, listName] of [['reactant', 'listOfReactants'], ['product', 'listOfProducts'], ['modifier', 'listOfModifiers']]) {
      const list = findChild(reaction, listName, SBML_NS);
      const tag = role === 'modifier' ? 'modifierSpeciesReference' : 'speciesReference';
      for (const reference of childElements(list, tag, SBML_NS)) {
        const referenceId = attribute(reference, 'id')?.value ?? null;
        if (referenceId) registerId(referenceId, reference, 'speciesReference');
        const target = role === 'modifier' ? attribute(reference, 'species')?.value : attribute(reference, 'species')?.value;
        if (!species.has(target)) pushIssue('sbml_reaction_species_unknown', reference, { reactionId, role, speciesId: target });
        const entry = {
          role,
          species: target,
          id: referenceId,
          stoichiometry: attribute(reference, 'stoichiometry')?.value ?? null,
          constant: attribute(reference, 'constant')?.value ?? null
        };
        participants.push(entry);
        pushRecord('reactionParticipant', `${reactionId}:${role}:${referenceId ?? target}`, {
          reactionId, ...entry
        }, reference);
      }
    }
    const kineticLaw = findChild(reaction, 'kineticLaw', SBML_NS);
    const localParameters = new Map();
    if (kineticLaw) {
      for (const localParameter of childElements(findChild(kineticLaw, 'listOfLocalParameters', SBML_NS), 'localParameter', SBML_NS)) {
        const id = attribute(localParameter, 'id')?.value ?? null;
        if (localParameters.has(id)) pushIssue('sbml_duplicate_local_parameter', localParameter, { reactionId, id });
        localParameters.set(id, localParameter);
        // 局部参数不注册为模型 id，也不覆盖全局参数；即使同名也各自独立保存。
        pushRecord('parameter', `reaction:${reactionId}:${id}`, {
          id,
          scope: `reaction:${reactionId}`,
          reactionId,
          value: attribute(localParameter, 'value')?.value ?? null,
          units: attribute(localParameter, 'units')?.value ?? null
        }, localParameter);
      }
      const math = findChild(kineticLaw, 'math', MATHML_NS) ?? findChild(kineticLaw, 'math', MATHML_NS_OLD);
      if (math) {
        const preserved = rawMathml(math, bytes);
        pushRecord('reactionKineticMath', reactionId, {
          reactionId,
          mathml: preserved.mathml,
          byteStart: preserved.byteStart,
          byteEnd: preserved.byteEnd,
          declaredNamespaces: preserved.declaredNamespaces
        }, math, preserved.location);
        for (const reference of collectMathReferences(math)) {
          const resolved = resolveSymbol(reference.symbol, reactionId, localParameters);
          if (!resolved) pushIssue('sbml_math_reference_unresolved', reference.element, {
            symbol: reference.symbol,
            reactionId,
            holder: 'kineticLaw'
          });
        }
      } else {
        pushIssue('sbml_kinetic_math_missing', kineticLaw, { reactionId });
      }
    }
    pushRecord('reaction', reactionId, {
      id: reactionId,
      name: attribute(reaction, 'name')?.value ?? null,
      reversible: attribute(reaction, 'reversible')?.value ?? null,
      compartment: attribute(reaction, 'compartment')?.value ?? null,
      participants
    }, reaction);
  }

  // 规则：变量引用要可解析，MathML 原文保留；规则影响解释范围，逐条给出处。
  const listOfRules = findChild(model, 'listOfRules', SBML_NS);
  for (const rule of childElements(listOfRules, null, SBML_NS)) {
    if (rule.namespaceUri !== SBML_NS) continue;
    if (!['assignmentRule', 'rateRule', 'algebraicRule'].includes(rule.localName)) continue;
    const variable = attribute(rule, 'variable')?.value ?? null;
    if (variable && !globalParameters.has(variable) && !species.has(variable) && !compartments.has(variable)) {
      pushIssue('sbml_rule_variable_unknown', rule, { ruleType: rule.localName, variable });
    }
    const math = findChild(rule, 'math', MATHML_NS) ?? findChild(rule, 'math', MATHML_NS_OLD);
    const preserved = math ? rawMathml(math, bytes) : null;
    if (!math) pushIssue('sbml_rule_math_missing', rule, { ruleType: rule.localName, variable });
    pushRecord('rule', `${rule.localName}:${variable ?? rule.location.byteStart}`, {
      ruleType: rule.localName,
      variable,
      mathml: preserved?.mathml ?? null,
      mathLocation: preserved?.location ?? null
    }, rule);
    if (math) for (const reference of collectMathReferences(math)) {
      if (!resolveSymbol(reference.symbol, null, new Map())) pushIssue('sbml_math_reference_unresolved', reference.element, {
        symbol: reference.symbol,
        holder: rule.localName,
        variable
      });
    }
  }

  // 初始赋值与约束同样可能改变解释范围，逐条登记并保留数学原文。
  for (const initialAssignment of childElements(findChild(model, 'listOfInitialAssignments', SBML_NS), 'initialAssignment', SBML_NS)) {
    const symbol = attribute(initialAssignment, 'symbol')?.value ?? null;
    if (symbol && !globalParameters.has(symbol) && !species.has(symbol) && !compartments.has(symbol)) {
      pushIssue('sbml_initial_assignment_symbol_unknown', initialAssignment, { symbol });
    }
    const math = findChild(initialAssignment, 'math', MATHML_NS) ?? findChild(initialAssignment, 'math', MATHML_NS_OLD);
    const preserved = math ? rawMathml(math, bytes) : null;
    pushRecord('initialAssignment', symbol ?? String(initialAssignment.location.byteStart), {
      symbol, mathml: preserved?.mathml ?? null, mathLocation: preserved?.location ?? null
    }, initialAssignment);
  }
  for (const constraint of childElements(findChild(model, 'listOfConstraints', SBML_NS), 'constraint', SBML_NS)) {
    const math = findChild(constraint, 'math', MATHML_NS) ?? findChild(constraint, 'math', MATHML_NS_OLD);
    const preserved = math ? rawMathml(math, bytes) : null;
    pushRecord('constraint', String(constraint.location.byteStart), {
      mathml: preserved?.mathml ?? null,
      mathLocation: preserved?.location ?? null,
      message: textOf(findChild(constraint, 'message', SBML_NS)).trim() || null
    }, constraint);
  }

  // 事件：触发条件与赋值目标都要可核对，MathML 原文保留。
  for (const event of childElements(findChild(model, 'listOfEvents', SBML_NS), 'event', SBML_NS)) {
    const eventId = attribute(event, 'id')?.value ?? null;
    registerId(eventId, event, 'event');
    const trigger = findChild(event, 'trigger', SBML_NS);
    const triggerMath = trigger ? (findChild(trigger, 'math', MATHML_NS) ?? findChild(trigger, 'math', MATHML_NS_OLD)) : null;
    if (!triggerMath) pushIssue('sbml_event_trigger_missing', event, { eventId });
    const assignments = [];
    for (const eventAssignment of childElements(findChild(event, 'listOfEventAssignments', SBML_NS), 'eventAssignment', SBML_NS)) {
      const variable = attribute(eventAssignment, 'variable')?.value ?? null;
      if (!globalParameters.has(variable) && !species.has(variable) && !compartments.has(variable)) {
        pushIssue('sbml_event_target_unknown', eventAssignment, { eventId, variable });
      }
      const math = findChild(eventAssignment, 'math', MATHML_NS) ?? findChild(eventAssignment, 'math', MATHML_NS_OLD);
      const preserved = math ? rawMathml(math, bytes) : null;
      assignments.push({ variable, mathml: preserved?.mathml ?? null, mathLocation: preserved?.location ?? null });
    }
    pushRecord('event', eventId ?? String(event.location.byteStart), {
      id: eventId,
      name: attribute(event, 'name')?.value ?? null,
      triggerMath: triggerMath ? rawMathml(triggerMath, bytes).mathml : null,
      triggerLocation: triggerMath ? loc(triggerMath) : null,
      useValuesFromTriggerTime: attribute(event, 'useValuesFromTriggerTime')?.value ?? null,
      assignments
    }, event);
  }

  // 未知命名空间下的扩展元素：保留原文与支持边界，不启用包语义。
  const walkExtensions = (element, path = '') => {
    for (const child of element.children ?? []) {
      if (child.type !== 'element') continue;
      if (child.namespaceUri && child.namespaceUri !== SBML_NS && child.namespaceUri !== MATHML_NS && child.namespaceUri !== MATHML_NS_OLD) {
        const info = extensionKind(child.namespaceUri);
        const start = child.location.byteStart;
        const end = child.location.byteEnd;
        pushRecord('extension', `element:${info.packageName ?? 'foreign'}:${start}`, {
          packageName: info.packageName,
          type: info.type,
          namespaceUri: child.namespaceUri,
          elementName: child.name,
          path: `${path}/${child.name}`,
          supported: false,
          rawXml: bytes.toString('utf8', start, end)
        }, child, loc(child));
        pushIssue('sbml_extension_unsupported', child, {
          elementName: child.name,
          namespaceUri: child.namespaceUri,
          packageName: info.packageName,
          scope: `${path}/${child.name} 子树`
        });
      } else {
        walkExtensions(child, `${path}/${child.localName}`);
      }
    }
  };
  walkExtensions(model, `/model${modelId ? `[id=${modelId}]` : ''}`);

  // 截断导致的未决内容：明确标注解释范围到哪里为止。
  if (root.truncated || model.truncated) {
    const cutStart = Math.max(...xmlIssues.map(issue => issue.location.byteEnd), model.location.byteEnd);
    issues.push({
      reason: 'sbml_input_truncated',
      location: `byte:${cutStart}-${bytes.length}`,
      receiptId,
      interpretedThroughByte: model.location.byteEnd,
      totalBytes: bytes.length,
      note: '文件在完整结束前截断；仅登记已完整解析的元素，未猜测缺失内容'
    });
  }

  return {
    records,
    issues,
    boundaries: {
      sbml: `${level ?? '?'}.${version ?? '?'}`,
      packages: [...packageRequired.entries()].map(([packageName, required]) => ({ packageName, required, supported: false })),
      mathExecuted: false,
      sourceKey: sourceKey ?? null
    }
  };
}
