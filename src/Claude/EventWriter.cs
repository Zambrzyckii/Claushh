// Stores every console event, then sends it to every console connection, under the conversation's lock that the caller
// holds (docs/ARCHITECTURE.md, "Backend" → "Console"). Text deltas are sent at once and stored as one row per messageId.
// It logs under Conversations' category, as before it was split out.
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.SignalR;

namespace Claushh.Api.Claude;

public sealed class EventWriter(ConversationLog store, IHubContext<ConsoleHub> hub, ILogger<Conversations> log)
{
    // Stores an event and sends it to every console connection; the caller holds the conversation's lock. Text deltas
    // are sent at once but stored as one row per messageId, written before the next other event.
    internal async Task EmitAsync(ConversationState state, JsonElement e)
    {
        if (e.GetProperty("type").GetString() == "text")
        {
            var messageId = e.GetProperty("messageId").GetString()!;
            if (state.OpenText is not { } open || open.MessageId != messageId)
            {
                await FlushTextAsync(state);
                state.OpenText = (messageId, new StringBuilder());
            }
            state.OpenText.Value.Text.Append(e.GetProperty("delta").GetString());
        }
        else
        {
            await FlushTextAsync(state);
            await StoreAsync(state, e);
        }
        try
        {
            await hub.Clients.All.SendAsync("ConsoleEvent", e);
        }
        catch (Exception ex)
        {
            log.LogWarning(ex, "Sending an event of console conversation {Conversation} failed", state.Key);
        }
    }

    private async Task FlushTextAsync(ConversationState state)
    {
        if (state.OpenText is { } open)
        {
            state.OpenText = null;
            await StoreAsync(state, ConsoleEvents.Text(state.Key, open.MessageId, open.Text.ToString()));
        }
    }

    // A failed insert is logged and the event is still sent.
    private async Task StoreAsync(ConversationState state, JsonElement e)
    {
        try
        {
            state.NextSeq ??= await store.NextSeqAsync(state.Id);
            var seq = state.NextSeq.Value;
            state.NextSeq = seq + 1;
            await store.AppendAsync(state.Id, seq, e.GetRawText());
        }
        catch (Exception ex)
        {
            log.LogError(ex, "Storing an event of console conversation {Conversation} failed; it was still sent", state.Key);
        }
    }
}
