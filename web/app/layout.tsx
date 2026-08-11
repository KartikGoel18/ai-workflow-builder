'use client';

import { NhostProvider } from '@nhost/react';
import { NhostClient } from '@nhost/nextjs';
import { Provider as UrqlProvider, createClient, defaultExchanges, subscriptionExchange } from 'urql';
import { createClient as createWSClient } from 'graphql-ws';
import { useEffect, useState } from 'react';
import './globals.css';

const nhost = new NhostClient({
  subdomain: process.env.NEXT_PUBLIC_NHOST_SUBDOMAIN || 'local',
  region: process.env.NEXT_PUBLIC_NHOST_REGION || 'local'
});

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const [urqlClient, setUrqlClient] = useState<any>(null);

  useEffect(() => {
    const wsClient = createWSClient({
      url: nhost.graphql.httpUrl.replace('http', 'ws'),
      connectionParams: () => {
        const token = nhost.auth.getAccessToken();
        return {
          headers: token ? { Authorization: `Bearer ${token}` } : {}
        };
      }
    });

    const client = createClient({
      url: nhost.graphql.httpUrl,
      fetchOptions: () => {
        const token = nhost.auth.getAccessToken();
        return {
          headers: token ? { Authorization: `Bearer ${token}` } : {}
        };
      },
      exchanges: [
        ...defaultExchanges,
        subscriptionExchange({
          forwardSubscription(request) {
            const input = { ...request, query: request.query || '' };
            return {
              subscribe(sink) {
                const unsubscribe = wsClient.subscribe(input, sink);
                return { unsubscribe };
              },
            };
          },
        }),
      ],
    });

    setUrqlClient(client);
  }, []);

  return (
    <html lang="en">
      <body>
        <NhostProvider nhost={nhost}>
          {urqlClient ? (
            <UrqlProvider value={urqlClient}>
              {children}
            </UrqlProvider>
          ) : (
            <div>Loading...</div>
          )}
        </NhostProvider>
      </body>
    </html>
  );
}
