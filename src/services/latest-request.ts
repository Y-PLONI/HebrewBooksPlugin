export class LatestRequest {
  private requestId = 0;

  begin(): number {
    this.requestId += 1;
    return this.requestId;
  }

  isCurrent(requestId: number): boolean {
    return requestId === this.requestId;
  }
}
