#!/usr/bin/env python3
"""Private provider adapter. stdin/stdout are the only protocol; never log secrets."""
import json
import os
import sys


def ads(request, ids):
    from google.ads.googleads.client import GoogleAdsClient
    config = {key: os.environ[name] for key, name in {
        "developer_token": "GOOGLE_ADS_DEVELOPER_TOKEN",
        "client_id": "GOOGLE_ADS_CLIENT_ID",
        "client_secret": "GOOGLE_ADS_CLIENT_SECRET",
        "refresh_token": "GOOGLE_ADS_REFRESH_TOKEN",
    }.items() if os.environ.get(name)}
    if len(config) != 4:
        raise RuntimeError("Google Ads credentials are not configured")
    login_customer_id = os.environ.get("PAPERCLIP_MEASUREMENT_GOOGLE_ADS_LOGIN_CUSTOMER_ID")
    if login_customer_id:
        config["login_customer_id"] = login_customer_id
    client = GoogleAdsClient.load_from_dict(config)
    service = client.get_service("GoogleAdsService")
    customer_id = ids[0]
    fields = "segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value"
    if request["report"] == "campaigns": fields = "campaign.name, " + fields
    query = f"SELECT {fields} FROM campaign WHERE segments.date BETWEEN '{request['startDate']}' AND '{request['endDate']}' ORDER BY segments.date LIMIT {request['rowLimit']}"
    rows = []
    for row in service.search(customer_id=customer_id, query=query):
        result = {"date": str(row.segments.date), "impressions": row.metrics.impressions, "clicks": row.metrics.clicks, "cost": row.metrics.cost_micros / 1000000, "conversions": row.metrics.conversions, "conversionValue": row.metrics.conversions_value}
        if request["report"] == "campaigns": result["campaign"] = row.campaign.name
        rows.append(result)
    columns = list(rows[0].keys()) if rows else (["date", "campaign", "impressions", "clicks", "cost", "conversions", "conversionValue"] if request["report"] == "campaigns" else ["date", "impressions", "clicks", "cost", "conversions", "conversionValue"])
    return columns, rows


def ga4_credentials():
    has_adc = bool(os.environ.get("GOOGLE_APPLICATION_CREDENTIALS"))
    analytics_names = ("GOOGLE_ANALYTICS_CLIENT_ID", "GOOGLE_ANALYTICS_CLIENT_SECRET", "GOOGLE_ANALYTICS_REFRESH_TOKEN")
    ads_names = ("GOOGLE_ADS_CLIENT_ID", "GOOGLE_ADS_CLIENT_SECRET", "GOOGLE_ADS_REFRESH_TOKEN")
    analytics_values = [os.environ.get(name) for name in analytics_names]
    ads_values = [os.environ.get(name) for name in ads_names]
    oauth_values = analytics_values if any(analytics_values) else ads_values
    has_oauth = any(oauth_values)
    if has_adc and has_oauth:
        raise RuntimeError("GA4 credential modes are mutually exclusive")
    if has_oauth:
        if not all(oauth_values):
            raise RuntimeError("GA4 OAuth credentials are incomplete")
        from google.oauth2.credentials import Credentials
        return Credentials(
            token=None,
            refresh_token=oauth_values[2],
            token_uri="https://oauth2.googleapis.com/token",
            client_id=oauth_values[0],
            client_secret=oauth_values[1],
            scopes=["https://www.googleapis.com/auth/analytics.readonly"],
        )
    if has_adc:
        return None
    raise RuntimeError("GA4 credentials are not configured")


def ga4(request, ids):
    from google.analytics.data_v1beta import BetaAnalyticsDataClient
    from google.analytics.data_v1beta.types import DateRange, Dimension, Metric, RunReportRequest
    credentials = ga4_credentials()
    client = BetaAnalyticsDataClient(**({"credentials": credentials} if credentials else {}))
    dimensions = [Dimension(name="date")]
    if request["report"] == "acquisition": dimensions += [Dimension(name="sessionSource"), Dimension(name="sessionMedium")]
    metrics = [Metric(name=name) for name in ["sessions", "totalUsers", "engagedSessions", "conversions", "totalRevenue"]]
    response = client.run_report(RunReportRequest(property=f"properties/{ids[0]}", dimensions=dimensions, metrics=metrics, date_ranges=[DateRange(start_date=request["startDate"], end_date=request["endDate"])], limit=request["rowLimit"]))
    columns = [header.name for header in response.dimension_headers] + [header.name for header in response.metric_headers]
    rows = [{**{columns[i]: value.value for i, value in enumerate(row.dimension_values)}, **{columns[len(row.dimension_values)+i]: value.value for i, value in enumerate(row.metric_values)}} for row in response.rows]
    return columns, rows


def main():
    request = json.load(sys.stdin)
    ids = json.loads(os.environ["PAPERCLIP_MEASUREMENT_ALLOWED_IDS"])
    columns, rows = ads(request, ids) if request["provider"] == "google_ads" else ga4(request, ids)
    json.dump({"provider": request["provider"], "report": request["report"], "startDate": request["startDate"], "endDate": request["endDate"], "columns": columns, "rows": rows, "rowCount": len(rows)}, sys.stdout)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Provider exceptions often include request/auth data. The Node facade returns a stable error.
        sys.stderr.write("Measurement provider request failed")
        sys.exit(1)
