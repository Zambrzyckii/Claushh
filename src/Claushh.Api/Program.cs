// API entry point. Further pieces (Identity with TOTP, EF Core + PostgreSQL,
// SignalR, ForwardedHeaders for Cloudflare Tunnel, rate limiting) are added
// in the stages described in docs/PLAN.md.

var builder = WebApplication.CreateBuilder(args);

var app = builder.Build();

app.MapGet("/api/health", () => Results.Ok(new { status = "ok" }));

app.Run();
