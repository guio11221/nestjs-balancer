require("reflect-metadata");
const { Module } = require("@nestjs/common");
const { NestFactory } = require("@nestjs/core");
const { RouteBalancerModule } = require("../../dist");
class AppModule {}
Module({
  imports: [
    RouteBalancerModule.forRoot({
      routes: [
        {
          path: "/api/users",
          upstreams: ["http://127.0.0.1:3001", "http://127.0.0.1:3002"],
          healthCheck: { path: "/health", intervalMs: 5000 },
        },
      ],
    }),
  ],
})(AppModule);
NestFactory.create(AppModule, { bodyParser: false })
  .then((app) => app.listen(3000))
  .then(() => console.log("gateway http://127.0.0.1:3000/api/users"))
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
