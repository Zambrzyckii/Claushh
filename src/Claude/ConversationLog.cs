// The console's tables (docs/ARCHITECTURE.md, "Backend" → "Console"): conversations, their events and the "always"
// rules. Each call uses its own scope, because its callers are singletons.
using Claushh.Api.Data;
using Microsoft.EntityFrameworkCore;

namespace Claushh.Api.Claude;

public sealed class ConversationLog(IServiceScopeFactory scopes, TimeProvider clock)
{
    public async Task<Conversation> CreateAsync(string projectPath)
    {
        await using var scope = scopes.CreateAsyncScope();
        var db = Db(scope);
        var now = clock.GetUtcNow();
        var conversation = new Conversation { Id = Guid.NewGuid(), ProjectPath = projectPath, StartedAt = now, LastEventAt = now };
        db.Conversations.Add(conversation);
        await db.SaveChangesAsync();
        return conversation;
    }

    public async Task<Conversation?> FindAsync(Guid id)
    {
        await using var scope = scopes.CreateAsyncScope();
        return await Db(scope).Conversations.AsNoTracking().FirstOrDefaultAsync(c => c.Id == id);
    }

    // The project's latest conversation, by its start.
    public async Task<Conversation?> LatestAsync(string projectPath)
    {
        await using var scope = scopes.CreateAsyncScope();
        return await Db(scope).Conversations.AsNoTracking().Where(c => c.ProjectPath == projectPath)
            .OrderByDescending(c => c.StartedAt).FirstOrDefaultAsync();
    }

    // A conversation's stored events in order, each as the JSON that was sent.
    public async Task<List<string>> EventsAsync(Guid id)
    {
        await using var scope = scopes.CreateAsyncScope();
        return await Db(scope).ConversationEvents.Where(e => e.ConversationId == id).OrderBy(e => e.Seq)
            .Select(e => e.Json).ToListAsync();
    }

    public async Task<int> NextSeqAsync(Guid id)
    {
        await using var scope = scopes.CreateAsyncScope();
        return (await Db(scope).ConversationEvents.Where(e => e.ConversationId == id).MaxAsync(e => (int?)e.Seq) ?? 0) + 1;
    }

    // One event; the conversation's LastEventAt moves with it.
    public async Task AppendAsync(Guid id, int seq, string json)
    {
        await using var scope = scopes.CreateAsyncScope();
        var db = Db(scope);
        db.ConversationEvents.Add(new ConversationEvent { ConversationId = id, Seq = seq, Json = json });
        await db.SaveChangesAsync();
        var now = clock.GetUtcNow();
        await db.Conversations.Where(c => c.Id == id).ExecuteUpdateAsync(s => s.SetProperty(c => c.LastEventAt, now));
    }

    public async Task MarkResumableAsync(Guid id)
    {
        await using var scope = scopes.CreateAsyncScope();
        await Db(scope).Conversations.Where(c => c.Id == id).ExecuteUpdateAsync(s => s.SetProperty(c => c.Resumable, true));
    }

    // Conversations whose last status is working or waiting: a turn that a stop or a crash cut off. An event that is not
    // valid jsonb (a \u0000 in a command's output) is skipped, so it cannot fail the query.
    public async Task<List<Guid>> UnfinishedAsync()
    {
        await using var scope = scopes.CreateAsyncScope();
        return await Db(scope).Database.SqlQueryRaw<Guid>("""
            SELECT c."Id" AS "Value" FROM "Conversations" c
            WHERE (SELECT events.j ->> 'state'
                   FROM (SELECT CASE WHEN pg_input_is_valid(e."Json", 'jsonb') THEN e."Json"::jsonb END AS j, e."Seq"
                         FROM "ConversationEvents" e WHERE e."ConversationId" = c."Id") events
                   WHERE events.j ->> 'type' = 'status'
                   ORDER BY events."Seq" DESC LIMIT 1) IN ('working', 'waiting')
            """).ToListAsync();
    }

    // The project's "always" rules, oldest first.
    public async Task<List<string>> RulesAsync(string projectPath)
    {
        await using var scope = scopes.CreateAsyncScope();
        return await Db(scope).ConsoleRules.Where(r => r.ProjectPath == projectPath).OrderBy(r => r.CreatedAt)
            .ThenBy(r => r.Rule).Select(r => r.Rule).ToListAsync();
    }

    // Saves a rule for the project; saving it again changes nothing.
    public async Task AddRuleAsync(string projectPath, string rule)
    {
        await using var scope = scopes.CreateAsyncScope();
        var now = clock.GetUtcNow();
        await Db(scope).Database.ExecuteSqlAsync(
            $"""INSERT INTO "ConsoleRules" ("ProjectPath", "Rule", "CreatedAt") VALUES ({projectPath}, {rule}, {now}) ON CONFLICT DO NOTHING""");
    }

    // Conversations whose last event is older than `cutoff`, with their events (cascade); the rules stay.
    public async Task<int> DeleteOlderThanAsync(DateTimeOffset cutoff, CancellationToken ct)
    {
        await using var scope = scopes.CreateAsyncScope();
        return await Db(scope).Conversations.Where(c => c.LastEventAt < cutoff).ExecuteDeleteAsync(ct);
    }

    private static ClaushhDbContext Db(AsyncServiceScope scope) => scope.ServiceProvider.GetRequiredService<ClaushhDbContext>();
}
