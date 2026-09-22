import { describe, expect, it } from "vitest";
import {
  ffLabel,
  matchersOf,
  queryTemplates,
  quoteLabelValue,
  quoteRegexPrefix,
  windowOf,
} from "../src/index.js";

/**
 * Truy vấn mẫu là hợp đồng giữa §7.4 (S3 đo cái gì), §6.6 (app gắn nhãn gì) và
 * §11.1 (middleware của Golden Path). Ba nơi phải cùng một lược đồ nhãn, và chỗ
 * duy nhất máy kiểm được điều đó là chuỗi PromQL sinh ra.
 */

const flag = {
  namespace: "udp-demo-dev",
  workloadName: "checkout",
  flagKey: "checkout_v2",
  variantKey: "on",
};
const service = {
  namespace: "udp-demo-dev",
  workloadName: "checkout",
  version: "1.4.0",
};
const q = queryTemplates();

describe("nhãn ff của §6.6", () => {
  it("một nhãn ghép <flagKey>=<variant>, không phải cặp nhãn", () => {
    expect(ffLabel("checkout_v2", "on")).toBe("checkout_v2=on");
    expect(matchersOf(flag)).toBe(
      '{service_name="checkout", namespace="udp-demo-dev", ff="checkout_v2=on"}',
    );
  });

  it("SERVICE_LEVEL lọc theo service_version, không có ff", () => {
    expect(matchersOf(service)).toBe(
      '{service_name="checkout", namespace="udp-demo-dev", service_version="1.4.0"}',
    );
  });
});

describe("bốn truy vấn của §7.4", () => {
  it("requestCount và errorCount là increase() tuyệt đối, errorCount thêm 5..", () => {
    expect(q.requestCount(flag, 60)).toBe(
      'sum(increase(http_server_request_duration_seconds_count{service_name="checkout", namespace="udp-demo-dev", ff="checkout_v2=on"}[60s]))',
    );
    expect(q.errorCount(flag, 60)).toBe(
      'sum(increase(http_server_request_duration_seconds_count{service_name="checkout", namespace="udp-demo-dev", ff="checkout_v2=on", http_response_status_code=~"5.."}[60s]))',
    );
  });

  it("errorRate là tỉ số hai rate() cùng cửa sổ", () => {
    expect(q.errorRate(service, 30)).toBe(
      'sum(rate(http_server_request_duration_seconds_count{service_name="checkout", namespace="udp-demo-dev", service_version="1.4.0", http_response_status_code=~"5..", ff=""}[30s])) / ' +
        'sum(rate(http_server_request_duration_seconds_count{service_name="checkout", namespace="udp-demo-dev", service_version="1.4.0", ff=""}[30s]))',
    );
  });

  it('[v4.7] truy vấn phân tích KHÔNG nhắm nhánh flag chỉ đọc series tổng ff="" — không đếm lặp 1 + T lần', () => {
    for (const query of [
      q.requestCount(service, 30),
      q.errorCount(service, 30),
      q.latencyP99(service, 30),
    ]) {
      expect(query).toContain('ff=""');
    }
    // Nhắm một nhánh ⇒ đúng một matcher ff, không có ff=""
    expect(q.requestCount(flag, 30)).not.toContain('ff=""');
    // Probe pha 2 và đếm mẫu KHÔNG được mang ff="" — cạnh ff=~ nó làm truy vấn luôn rỗng
    expect(q.probeSeries(flag, 300)).not.toContain('ff=""');
    expect(q.scrapeSamples(flag, 300)).not.toContain('ff=""');
  });

  it("latencyP99 là histogram_quantile trên _bucket theo le", () => {
    expect(q.latencyP99(flag, 60)).toBe(
      'histogram_quantile(0.99, sum by (le) (rate(http_server_request_duration_seconds_bucket{service_name="checkout", namespace="udp-demo-dev", ff="checkout_v2=on"}[60s])))',
    );
  });

  it("probe pha 2 kiểm LƯU LƯỢNG theo flagKey, không theo variant; pha 1 theo workload (§7.4 [v4.4])", () => {
    expect(q.probeSeries(flag, 300)).toBe(
      'count(increase(http_server_request_duration_seconds_count{service_name="checkout", namespace="udp-demo-dev", ff=~"checkout_v2=.*"}[300s]) > 0)',
    );
    expect(
      q.probeSeries(
        { namespace: service.namespace, workloadName: service.workloadName },
        300,
      ),
    ).toBe(
      'count(increase(http_server_request_duration_seconds_count{service_name="checkout", namespace="udp-demo-dev"}[300s]) > 0)',
    );
  });

  it("scrape interval đo trên series của CHÍNH workload, không theo ff/version", () => {
    expect(q.scrapeSamples(flag, 300)).toBe(
      'max(count_over_time(http_server_request_duration_seconds_count{service_name="checkout", namespace="udp-demo-dev"}[300s]))',
    );
  });

  it("tên metric ghi đè được cho app dùng tên riêng", () => {
    const custom = queryTemplates("http_requests");
    expect(custom.requestCount(service, 60)).toContain("http_requests_count{");
    expect(custom.latencyP99(service, 60)).toContain("http_requests_bucket{");
  });
});

describe("escape — dữ liệu người dùng không được sửa được truy vấn", () => {
  it("quoteLabelValue escape ngoặc kép, gạch chéo ngược, xuống dòng", () => {
    expect(quoteLabelValue('a"b\\c\nd')).toBe('"a\\"b\\\\c\\nd"');
  });

  it("quoteRegexPrefix escape ký tự regex rồi thêm .*", () => {
    // PromQL đọc "\." thành regex \. — nên chuỗi nguồn JS mang HAI gạch chéo ngược
    expect(quoteRegexPrefix("flag.v2=")).toBe('"flag\\\\.v2=.*"');
    expect(quoteRegexPrefix("a+b(")).toBe('"a\\\\+b\\\\(.*"');
  });

  it("tên flag chứa ký tự lạ vẫn ra một matcher hợp lệ", () => {
    const evil = { ...flag, flagKey: 'x"} or {y=~".*' };
    expect(matchersOf(evil)).toBe(
      '{service_name="checkout", namespace="udp-demo-dev", ff="x\\"} or {y=~\\".*=on"}',
    );
  });

  it("metricBase phải là tên metric hợp lệ — dữ liệu người dùng không được thành PromQL", () => {
    expect(() => queryTemplates("http_requests")).not.toThrow();
    expect(() => queryTemplates("x_count{}) or vector(0) #")).toThrow(
      /Tên metric không hợp lệ/,
    );
    expect(() => queryTemplates("1abc")).toThrow(/Tên metric không hợp lệ/);
  });

  it("cửa sổ chỉ nhận giây nguyên dương", () => {
    expect(windowOf(60)).toBe("[60s]");
    expect(() => windowOf(0)).toThrow(/nguyên dương/);
    expect(() => windowOf(1.5)).toThrow(/nguyên dương/);
  });
});
