# AI features

Two optional features use a language model: category suggestions for transactions, and a read-only assistant that answers questions about your finances. Both are off until an administrator sets them up in **Settings → AI features**.

## Connect a provider

Choose OpenAI or Amazon Bedrock. Both features share one connection, and each picks its own model.

- **OpenAI:** enter an API key, then the model ID for each feature.
- **Amazon Bedrock:** enter the region and a permanent access key ID and secret access key. Temporary credentials are not supported. After you save, the model lists fill from your account, grouped by provider.

**Test saved connection** checks the credentials without calling a model. **Test saved model** sends one small synthetic request, which your provider may charge for. Changing the connection pauses both features until you re-enable them. Switching provider also clears the chosen models.

For Bedrock, the IAM user needs:

- `bedrock:ListFoundationModels` and `bedrock:ListInferenceProfiles` on `*`, to list models.
- `bedrock:InvokeModel` on the chosen models or inference profiles.
- `bedrock:GetFoundationModelAvailability` and `bedrock:GetInferenceProfile`, checked before each request.

Choose a small, inexpensive model. Classification needs JSON output; the assistant needs tool use.

## Category suggestions

Your own corrections, rules and the bank's categories come first. The model only suggests a category for posted transactions those leave unresolved.

- With **automatic suggestions** on, new transactions are suggested automatically, starting from the day you turned it on. Settings shows that date.
- **Also suggest categories for older transactions** covers everything before that date. Settings shows how many transactions that is; each costs one request.
- Suggestions wait in the review queue. **Automatically apply validated category suggestions** applies them directly. It is off by default.
- The transaction editor can ask for a suggestion on demand, for any date.

Each request contains the transaction description, cut short with long numbers removed, and your category names. No amounts, account details or credentials are sent.

## Assistant

Turn the assistant on, choose its model and acknowledge the data-sharing notice. It opens from the **Assistant** button.

The assistant reads through the same permissions as the person asking: members see only the accounts and budgets they have been granted. It cannot change anything, send messages or browse the web. Your question and the financial data it looks up are sent to the provider. A conversation holds up to 25 questions.

OpenAI requests are sent with `store: false`, which is not a guarantee of zero retention; check your OpenAI data controls. Bedrock retention depends on the model, the region and your AWS logging settings.
