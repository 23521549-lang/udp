var app = WebApplication.CreateBuilder(args).Build();
app.Urls.Add($"http://0.0.0.0:{Environment.GetEnvironmentVariable("PORT") ?? "8080"}");
app.MapGet("/healthz", () => "ok");
app.Run();
