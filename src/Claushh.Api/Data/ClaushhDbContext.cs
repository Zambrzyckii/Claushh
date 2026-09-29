// EF Core context: Identity tables (AspNetUsers, ...), login sessions and login attempts. Schema changes only through migrations
// in Data/Migrations, applied at startup (Program.cs).
using Claushh.Api.Auth;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;

namespace Claushh.Api.Data;

public sealed class ClaushhDbContext(DbContextOptions<ClaushhDbContext> options) : IdentityDbContext<IdentityUser>(options)
{
    public DbSet<Session> Sessions => Set<Session>();
    public DbSet<LoginAttempt> LoginAttempts => Set<LoginAttempt>();

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
            attempt.HasIndex(a => new { a.Ip, a.At });
            attempt.HasIndex(a => a.At);
        });
    }
}
