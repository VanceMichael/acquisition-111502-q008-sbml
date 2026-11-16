# 来源资料契约

支持 SBML L3V2 core 的模型、隔室、物种、单位、参数、反应参与者、规则和事件声明，保留 MathML，不执行数学。species 的 value 使用 id、compartment、initialKind（amount/concentration/unspecified）与原值。parameter 的 value 用 scope=model 或 reaction:r1 区分，并保存 id、value。未知命名空间扩展保留原文并记录支持边界，不启用 DTD 或联网实体。相同名字不等于相同 SBML id。

每条已解释资料均可回到真实来源收件和具体位置。原始载荷与版本必须继续可查，不能以解析后的摘要替代原文。未列出的标准扩展允许明确标识未支持，不允许假称已解释。

解释细则：parameter 记录的 key 形如 model/<id> 与 reaction:<反应id>/<id>，两个作用域各自独立。物种、反应参与者、规则与事件变量、单位属性与数学 ci 引用都要能解析到模型内已声明对象（反应内 ci 先解析本反应局部参数），核对不上记为未决问题并附出处；csymbol 保留原文不展开。notes 与 annotation 是 core 定义的文档性容器，其内容不参与语义解释。unitDefinition 的 id 与模型 SId 分属不同命名空间，分别登记。文档无法完整解析（截断、DTD、未定义实体等）时整体不解释，只留指出字节位置的问题单，原文以收件为准。
