# 来源资料契约

支持 SBML Level 3 Version 2 core 的模型、隔室、物种、单位定义、参数、反应与参与者、动力学定律、规则、初始赋值、约束和事件声明。结构化接入只做声明、核对与登记，不执行数学；MathML 按收件原始字节整体保留（含其自身命名空间声明），并附字节区间出处，不做等价改写。

## 值的保存规则

- species 的 value 使用 id、name、compartment、initialKind（amount/concentration/unspecified/amount-and-concentration）与原值。`initialConcentration` 与 `initialAmount` 分别按来源字符串保存，缺失为 null，绝不互相换算；同一元素同时出现两者时登记 `sbml_species_initial_conflict`。相同 name 不等于相同 SBML id，跨隔室同名物种各自独立，并登记 `sbml_species_shared_name` 供人工复核。
- parameter 的 value 用 scope 区分：全局参数 `scope=model`，键为 `model:<id>`；反应内局部参数 `scope=reaction:<reactionId>`，键为 `reaction:<reactionId>:<id>`。局部参数不注册为模型级 id，也不覆盖同名全局参数；value、units 等均保留来源字符串。
- compartment 的 size、unitDefinition 的 kind/exponent/scale/multiplier、stoichiometry 等数值一律保留原始字符串，不解析为数字、不做单位换算。

## 记录种类（kind）

`model`、`compartment`、`species`、`unitDefinition`、`parameter`、`reaction`、`reactionParticipant`（reactant/product/modifier）、`reactionKineticMath`（原始 MathML）、`rule`（assignmentRule/rateRule/algebraicRule）、`initialAssignment`、`constraint`、`event`、`extension`。每条记录的 provenance 至少含一个真实收件 receiptId 与可复查 location（字节区间加行列）。

## 相互核对

- 物种的 compartment、反应参与者的 species、compartment 的 outside、规则/事件/初始赋值的目标符号必须能在已声明 id 中解析；未解析登记 `*_unknown` / `sbml_math_reference_unresolved` issue，引用本身仍保留，可处于未决状态。
- MathML 中 `ci`/`csymbol` 按反应作用域解析：先查该反应 localParameter，再查模型级 parameter、species、compartment、functionDefinition。
- 单位引用必须命中内置单位或本模型 unitDefinition；重复 SId、重复局部参数、重复 id 分别登记 issue，不静默丢弃。

## 扩展与边界

未知命名空间扩展保留原文（rawXml）并记录支持边界，不启用 DTD、不解析外部或网络实体、不加载网络资源。SBML L3 标准扩展包按命名空间识别包名与 required 标志，登记 `sbml_package_unsupported` 与 extension 记录，包内语义标记 `supported:false`，不假称已解释。截断输入在 lenient 解析下保留所有已完整闭合的元素，并以 `sbml_input_truncated` 标明解释截止字节；缺失资料不等于来源明确删除。

每条已解释资料均可回到真实来源收件和具体位置。原始载荷与版本必须继续可查，不能以解析后的摘要替代原文。未列出的标准扩展允许明确标识未支持，不允许假称已解释。
