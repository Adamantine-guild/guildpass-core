import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { config } from './config';
import { registerRoutes } from './routes';

const server = Fastify({ logger: true });

async function main() {
  await server.register(swagger, {
    openapi: {
      info: {
        title: 'GuildPass Access API',
        description: 'MVP API for wallet membership and access checks',
        version: '0.1.0',
      },
      servers: [{ url: 'http://localhost:3000' }],
    },
  });
  await server.register(swaggerUi, {
    routePrefix: '/docs',
  });

  registerRoutes(server);

  await server.listen({ port: config.port, host: '0.0.0.0' });
}

main().catch((err) => {
  server.log.error(err);
  process.exit(1);
});
