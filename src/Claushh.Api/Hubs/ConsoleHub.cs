// /hubs/console (docs/ARCHITECTURE.md, "Console"): the methods check their arguments and leave the conversations to
// Conversations, a singleton, because a hub instance lives for one call. The connection rules are the shared ones of
// Hubs/.
using Claushh.Api.Claude;
using Microsoft.AspNetCore.SignalR;

namespace Claushh.Api.Hubs;

public sealed class ConsoleHub(Conversations conversations) : Hub
{
    public Task<ConversationSnapshot> GetConversation(string? projectPath) => conversations.GetAsync(projectPath);

    public Task<string> StartConversation(string? projectPath) => conversations.StartConversationAsync(projectPath);
}
