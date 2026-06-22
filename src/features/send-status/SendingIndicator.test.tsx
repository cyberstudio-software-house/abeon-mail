import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { SendingIndicator } from "./SendingIndicator";
import { useUiStore } from "../../app/store";

describe("SendingIndicator", () => {
  beforeEach(() => {
    useUiStore.setState({ sendingCount: 0, lastSentAt: null, sendWatchdogs: [] });
  });
  afterEach(cleanup);

  it("shows 'Sending…' for a single in-flight send", () => {
    useUiStore.setState({ sendingCount: 1 });
    const { getByText } = render(<SendingIndicator />);
    expect(getByText("Sending…")).toBeTruthy();
  });

  it("shows a count when more than one send is in flight", () => {
    useUiStore.setState({ sendingCount: 3 });
    const { getByText } = render(<SendingIndicator />);
    expect(getByText("Sending (3)…")).toBeTruthy();
  });

  it("shows 'Sent' briefly after the last send completes", () => {
    useUiStore.setState({ sendingCount: 0, lastSentAt: Date.now() });
    const { getByText, container } = render(<SendingIndicator />);
    expect(getByText("Sent")).toBeTruthy();
    expect(container.querySelector(".sending-indicator--sent")).not.toBeNull();
  });

  it("renders nothing when idle", () => {
    useUiStore.setState({ sendingCount: 0, lastSentAt: null });
    const { container } = render(<SendingIndicator />);
    expect(container.querySelector(".sending-indicator")).toBeNull();
  });

  it("renders nothing when the 'Sent' window has elapsed", () => {
    useUiStore.setState({ sendingCount: 0, lastSentAt: Date.now() - 10000 });
    const { container } = render(<SendingIndicator />);
    expect(container.querySelector(".sending-indicator")).toBeNull();
  });
});
