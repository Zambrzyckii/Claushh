// /hubs/console (docs/ARCHITECTURE.md, "Console"): the methods check their arguments and leave the conversations to
// Conversations, a singleton, because a hub instance lives for one call. The connection rules are the shared ones of
// Hubs/.
using Claushh.Api.Claude;
using Microsoft.AspNetCore.SignalR;

namespace Claushh.Api.Hubs;

public sealed class ConsoleHub(Conversations conversations) : Hub
{
    // A prompt of up to 100,000 UTF-16 units, so this hub alone accepts messages up to 1 MiB (Program.cs).
    public const int MaxPrompt = 100_000;
    public const long MaxMessage = 1024 * 1024;

    public sealed record PromptRequest(string? ConversationId, string? Text, string? Model, string? Effort, string? Mode);
    public sealed record InterruptRequest(string? ConversationId);

    public Task<ConversationSnapshot> GetConversation(string? projectPath) => conversations.GetAsync(projectPath);

    public Task<string> StartConversation(string? projectPath) => conversations.StartConversationAsync(projectPath);

    // Returns once the prompt is written to the CLI; the turn's events follow on ConsoleEvent.
    public async Task SendPrompt(PromptRequest request)
    {
        if (request.Text is not { Length: >= 1 and <= MaxPrompt } text)
        {
            throw new HubException("Nieprawidłowe polecenie");
        }
        if (!PromptOptions.IsValid(request.Model, request.Effort, request.Mode))
        {
            throw new HubException("Nieprawidłowe opcje");
        }
        await conversations.SendPromptAsync(request.ConversationId, text, new PromptOptions(request.Model!, request.Effort!, request.Mode!));
    }

    public Task Interrupt(InterruptRequest request) => conversations.InterruptAsync(request.ConversationId);
}
