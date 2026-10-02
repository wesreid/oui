## Conversations

The agent client never makes HTTP requests; the product supplies callbacks. Beyond `createConversation` and `sendMessage` (which passes an approval continuation through unchanged, as `approval`), two optional callbacks let a person return to earlier conversations: `listConversations({ limit, offset, … })` and `getConversation(id)`. With `getConversation`, the client also restores the tab's active conversation after a reload. Both must return only the signed-in person's conversations.
