# Bounded Google Measurement for `pi_local`

`pi_local` can expose one read-only tool, `measurement_query`, when its adapter config sets `measurementEnabled: true`. The tool is a Paperclip HTTP gateway, not a direct MCP client: Pi has no built-in MCP client, and the gateway keeps Google credentials out of the model process.

## Surface

The only request fields are:

- `provider`: `google_ads` or `ga4`
- `report`: `summary`; `campaigns` (Google Ads only); or `acquisition` (GA4 only)
- `startDate`, `endDate`: ISO dates, maximum 31 days, never future
- `rowLimit`: 1–500

It accepts no GAQL, raw provider request, filter, credential, page token, or mutation operation. Google Ads uses its reporting search API internally (a POST read); GA4 uses `runReport`. Both calls are semantically read-only.

## Server-only configuration

Set these only on the Paperclip server/deployment secret binding, never in `adapterConfig.env`, prompts, Pi config, or agent environment:

```text
PAPERCLIP_MEASUREMENT_CONFIG={"companies":{"<company-uuid>":{"googleAdsCustomerIds":["1234567890"],"googleAdsLoginCustomerId":"9876543210","ga4PropertyIds":["123456789"]}}}
GOOGLE_ADS_DEVELOPER_TOKEN=...
GOOGLE_ADS_CLIENT_ID=...
GOOGLE_ADS_CLIENT_SECRET=...
GOOGLE_ADS_REFRESH_TOKEN=...
# Choose exactly one GA4 mode:
GOOGLE_APPLICATION_CREDENTIALS=/run/secrets/google-ga4-service-account.json
# or the existing GOOGLE_ADS_CLIENT_ID / GOOGLE_ADS_CLIENT_SECRET /
# GOOGLE_ADS_REFRESH_TOKEN OAuth tuple, authorized for analytics.readonly
PAPERCLIP_MEASUREMENT_PYTHON=/opt/google-ads-python/bin/python
```

`PAPERCLIP_MEASUREMENT_CONFIG` is a non-secret allowlist. `googleAdsLoginCustomerId` is optional, numeric, and is passed only to the Google Ads client as `login_customer_id` (for manager-account access). The feature fails closed, at request time, if configuration is omitted, malformed, missing the requesting company, or missing the chosen provider's IDs; it never prevents Paperclip from starting.

GA4 has exactly two mutually exclusive server-side credential modes: ADC/service-account credentials through `GOOGLE_APPLICATION_CREDENTIALS`, or the existing Ads OAuth client-id/client-secret/refresh-token tuple authorized with `analytics.readonly`. Configuring any OAuth value alongside ADC is rejected.

The Google credential variables, GA4 service-account path, measurement configuration, provider Python path, selected allowlist, and Ads login customer ID are explicit server-only values. The `pi_local` adapter removes every one from both local and remote spawned Pi environments; Pi only receives its normal Paperclip agent token and calls `POST /api/companies/:companyId/measurement/query`.

The endpoint requires an agent token for the same company. It returns normalized columns/rows only. Provider failures are stable, generic errors; the provider subprocess is time- and output-bounded.

## Docker

The production image installs `google-ads` and `google-analytics-data` into `/opt/google-ads-python`. Bind the service-account file as a deployment secret and set `GOOGLE_APPLICATION_CREDENTIALS` to its in-container path. For lue-kube, supply the variables/files through the workload secret binding; do not put values in a manifest, `models.json`, or adapter configuration.

## Operations

- Enable `measurementEnabled` only on the intended company agent; it is per run and does not create a global Pi extension/config entry.
- Timer heartbeats remain unchanged/off; this capability never schedules itself.
- The endpoint is intentionally agent-only. Board/operator reporting needs a separate reviewed surface.
