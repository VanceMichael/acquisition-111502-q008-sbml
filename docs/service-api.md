# 收件服务接口

人工资料接收保持兼容。POST /intakes 的 JSON 字段为 collectionId、sourceKey、revision、mediaType、contentBase64；返回 receiptId、sha256、byteLength 和轻量 summary。相同资料集、来源键与修订对应同一收件，字节不同返回 409。GET /receipts/{receiptId} 可读元数据，GET /receipts/{receiptId}/body 返回原字节。

POST /acquisitions 接受 collectionId、entry 和可选 options，entry 是授权来源完整地址。领取入口原始内容并登记收件后，若入口是交付索引（含 deliveryId 与 roots 的 JSON），按 roots 逐个领取同包依赖并同样登记收件；每份 SBML 字节随即按 docs/source-contract.md 解释为结构化 records 与 issues，返回 collectionId 和 receiptIds。所有自动取得的依赖都保留真实原文收件，不用人工造 records 代替自动接入。入口本身领取失败按错误返回；单个依赖领取失败只记为问题，不影响其余资料入库。来源访问只限启动时冻结的 origin，不能访问其他主机或执行交付件。

GET /collections 返回资料集列表，GET /collections/{collectionId} 返回 collectionId、receiptIds、records、issues。结构化 records 的每项包含 kind、key、value、provenance；key 由各来源身份语义决定，不要求特定内部编码。provenance 是含 receiptId 与 location 的数组，location 可采用字节区间、原行列、JSON Pointer 等可复查定位；自动解释使用 bytes:起始-结束（指向 receipt 正文中声明元素的原文区间，语法错误用 bytes:偏移 的点定位），交付索引级问题使用索引内的 JSON Pointer。issues 每项包含 reason、location，至少能说明原因、受影响范围和已有来源依据，不能用静默丢弃表示未知。缺失资料不等于来源明确删除。

自动解释入库遵循同键幂等：同键同值的重复解释只合并出处；同一来源键的新修订若给出同键异值，不覆盖已归档记录，记 record_identity_conflict 问题并附新修订出处，各修订的原文收件均可经 GET /receipts/{receiptId}/body 回查。

POST /collections/{collectionId}/records 可录入人工确认记录，必须附本资料集的真实收件出处。自动接入不能依赖操作者事先写入答案。该接口目前采用同键不可变约定；新增版本、历史记录与当前视图如何协调，应与来源语义相符，不能覆盖已归档原文。来源契约中的值是查询视图契约，不限定解析器、状态机或索引的内部实现。

本地 provider 是独立 HTTP 来源，fixtures 为合成的公开样本，不包含真实个人或机构凭据。fixtures/descriptor.json 说明来源入口与接入选项。多数资料源用 /deliveries 声明 deliveryId、revision、roots 和 resources；roots 是需处理的独立入口，resources 是同包可领取资源，不是公网搜索指令。文件可用 GET、HEAD 与单段 Range 读取；ETag 表示返回字节的身份。SOURCE_STAGE=partial 启动不完整交付状态，完整状态是默认值。来源服务不接受写操作。
