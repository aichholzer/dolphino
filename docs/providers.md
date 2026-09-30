# Classification providers

Choose OpenAI or Amazon Bedrock in Settings and enter a model identifier manually. Model availability, pricing and regional access vary; Profe does not maintain a potentially stale model catalogue. Credentials are write-only encrypted settings. Leaving classification disabled still permits the explicit test actions. Import classification is subject to the configured daily request cap and batch limit; jobs are durable and deduplicated. Existing manual, rule and provider categories retain precedence. Automatic application is a separate opt-in, and all returned categories must match the supplied allowlist.

**Test connection** is read-only: OpenAI retrieves metadata for the selected model; Bedrock calls STS GetCallerIdentity. The AWS result means credentials are valid, not that inference permissions or model availability are sufficient. No account identifier or identity ARN is returned to the browser.

**Test model** sends only a fictional grocery description and two category names. It can incur a small inference charge and never reads transactions. It must be explicitly requested. Ordinary classification sends only the first 120 description characters (long numeric strings redacted) and permitted category names. It does not send balances, amounts, account identifiers or transaction IDs. Descriptions can still contain personal information: enable only with that understanding.

OpenAI uses the fixed official HTTPS Chat Completions endpoint, with JSON output, `store:false`, and at most 150 completion tokens. Models must support this contract; some reasoning models may exhaust that small token budget before producing a valid response. Choose a suitable inexpensive model and run the synthetic test. Redirects are rejected. An operator-configured legacy `LLM_BASE_URL` remains supported only when there is no Settings provider; the UI cannot supply arbitrary endpoints.

Bedrock uses AWS SDK v3 signing and Converse with a 150-token output cap. Choose an AWS region from the supplied dropdown and configure a permanent access key ID and secret access key. Temporary AWS access keys (ASIA prefix) and session tokens are not supported; they are rejected rather than silently used without their required token. Credentials are explicit; the SDK never falls back to a host instance role or ambient credential chain. Enter a foundation model ID/ARN or inference profile ID/ARN. Prompt resources, provisioned/custom/marketplace endpoints and unknown resource types are not supported by this MVP availability guard.

Before **every Bedrock inference**, Profe checks GetFoundationModelAvailability for the foundation model. Inference profiles are resolved read-only via GetInferenceProfile; all underlying foundation models are checked in their respective regions. Agreement, entitlement and regional availability must be AVAILABLE and authorization must be AUTHORIZED. Unknown availability, missing read permissions or unavailable models fail closed without inference. Profe never creates an agreement, subscribes to AWS Marketplace, provisions model access or accepts terms. A user must arrange model access separately in AWS. This is intentional because a first invocation with overly broad AWS permissions can otherwise initiate marketplace subscription/access workflows.

Give the dedicated AWS identity only `bedrock:InvokeModel` on the selected model/profile and its underlying permitted models, read-only `bedrock:GetInferenceProfile` and `bedrock:GetFoundationModelAvailability` as needed, and STS GetCallerIdentity capability (AWS does not require a separate allow for this identity check). Availability APIs may require wildcard resource scope; consult AWS IAM service authorization for the current API. Do **not** give this identity Marketplace subscribe/unsubscribe rights, Bedrock agreement creation or general administrator policies. Cross-region profiles require invoke access for all their destination models and may send the minimal description to those regions. SDK retries are disabled so durable job retries and cost accounting remain authoritative; calls use a 15-second abort signal. Provider errors returned to users/jobs are generic and never include raw response bodies or SDK credential metadata.

Official references checked during implementation:

- [OpenAI Chat API](https://developers.openai.com/api/reference/resources/chat)
- [Bedrock Converse](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html)
- [Bedrock model access](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html)
- [GetFoundationModelAvailability](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_GetFoundationModelAvailability.html)
- [GetInferenceProfile](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_GetInferenceProfile.html)


## Region catalogue maintenance

Settings serves the region dropdown from `backend/src/provider-regions.js`, verified on 2026-09-30 against the **bedrock-runtime** column in the [AWS regional endpoint guide](https://docs.aws.amazon.com/bedrock/latest/userguide/endpoints-region-availability.html), cross-checked with the [AWS endpoints reference](https://docs.aws.amazon.com/general/latest/gr/bedrock.html). The regional guide lists newer runtime regions than the general runtime table. This 32-region commercial catalogue includes only documented runtime endpoints, not every control-plane region. A listed region does not guarantee any particular model supports Converse there: model availability and permissions are still checked before inference.

To refresh, a maintainer compares the runtime table against the catalogue, checks [Converse/model regional support](https://docs.aws.amazon.com/bedrock/latest/userguide/models-regions.html), updates entries and `verifiedOn`, runs provider/settings tests, and ships the code update. The app never downloads executable configuration or scrapes an arbitrary URL at runtime. Operators needing a newly supported region must update this maintained list first. GovCloud and other isolated partitions are outside this commercial-region catalogue. Sydney (`ap-southeast-2`) is the UI default.

Also consult the [Bedrock endpoints and regional availability guide](https://docs.aws.amazon.com/bedrock/latest/userguide/endpoints-region-availability.html) during catalogue refresh.
