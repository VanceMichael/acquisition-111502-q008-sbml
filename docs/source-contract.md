# 来源资料契约

支持 SBML L3V2 core 的模型、隔室、物种、单位、参数、反应参与者、规则和事件声明，保留 MathML，不执行数学。species 的 value 使用 id、compartment、initialKind（amount/concentration/unspecified）与原值。parameter 的 value 用 scope=model 或 reaction:r1 区分，并保存 id、value。未知命名空间扩展保留原文并记录支持边界，不启用 DTD 或联网实体。相同名字不等于相同 SBML id。

每条已解释资料均可回到真实来源收件和具体位置。原始载荷与版本必须继续可查，不能以解析后的摘要替代原文。未列出的标准扩展允许明确标识未支持，不允许假称已解释。
