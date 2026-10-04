// EF Core context: Identity tables (AspNetUsers, ...), login sessions, login attempts, workspace names, and the console's
// conversations, events and "always" rules. Schema changes only through migrations in Data/Migrations, applied at
// startup (Program.cs).
using Claushh.Api.Auth;
using Claushh.Api.Claude;
using Claushh.Api.Workspaces;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;

namespace Claushh.Api.Data;

public sealed class ClaushhDbContext(DbContextOptions<ClaushhDbContext> options) : IdentityDbContext<IdentityUser>(options)
{
    public DbSet<Session> Sessions => Set<Session>();
    public DbSet<LoginAttempt> LoginAttempts => Set<LoginAttempt>();
    public DbSet<Workspace> Workspaces => Set<Workspace>();
    public DbSet<Conversation> Conversations => Set<Conversation>();
    public DbSet<ConversationEvent> ConversationEvents => Set<ConversationEvent>();
    public DbSet<ConsoleRule> ConsoleRules => Set<ConsoleRule>();

    protected override void OnModelCreating(ModelBuilder builder)
    {
        base.OnModelCreating(builder);
        builder.Entity<Session>(session =>
        {
            session.HasIndex(s => s.SecretHash).IsUnique();
            session.HasOne(s => s.User).WithMany().HasForeignKey(s => s.UserId).OnDelete(DeleteBehavior.Cascade);
        });
        builder.Entity<LoginAttempt>(attempt =>
        {
            attempt.HasIndex(a => new { a.LimitKey, a.At });
            attempt.HasIndex(a => a.At);
        });
        builder.Entity<Workspace>().HasKey(w => w.Directory);
        builder.Entity<Conversation>().HasIndex(c => new { c.ProjectPath, c.StartedAt });
        builder.Entity<ConversationEvent>(e =>
        {
            e.HasKey(x => new { x.ConversationId, x.Seq });
            e.HasOne<Conversation>().WithMany().HasForeignKey(x => x.ConversationId).OnDelete(DeleteBehavior.Cascade);
        });
        builder.Entity<ConsoleRule>().HasKey(r => new { r.ProjectPath, r.Rule });
    }
}
