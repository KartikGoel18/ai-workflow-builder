import { GraphQLClient } from 'graphql-request';

const NHOST_GRAPHQL_URL = process.env.NHOST_GRAPHQL_URL || 'http://localhost:8080/v1/graphql';
const NHOST_ADMIN_SECRET = process.env.NHOST_ADMIN_SECRET || 'nhost-admin-secret';

export const graphqlClient = new GraphQLClient(NHOST_GRAPHQL_URL, {
  headers: {
    'x-hasura-admin-secret': NHOST_ADMIN_SECRET,
  },
});
