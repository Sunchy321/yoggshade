/** 一个在途请求 + 一个最新待处理请求。过期结果也必须释放其 Blob URL。 */
export class LatestRender<Input, Output> {
  private revision = 0;
  private running = false;
  private queued?: { value: Input, revision: number };
  private disposed = false;

  constructor(
    private run: (input: Input) => Promise<Output>,
    private accept: (output: Output) => void,
    private reject: (error: unknown) => void,
    private release: (output: Output) => void,
  ) {}

  /** 每次编辑立即作废旧结果，防抖期间也不能接受旧输入的结果。 */
  invalidate(): void {
    this.revision++;
    this.queued = undefined;
  }

  submit(value: Input): void {
    if (this.disposed) return;
    this.queued = { value, revision: this.revision };
    void this.drain();
  }

  dispose(): void {
    this.disposed = true;
    this.invalidate();
  }

  private async drain(): Promise<void> {
    if (this.running || this.disposed) return;
    this.running = true;
    while (this.queued && !this.disposed) {
      const request = this.queued;
      this.queued = undefined;
      try {
        const result = await this.run(request.value);
        if (this.disposed || request.revision !== this.revision) this.release(result);
        else this.accept(result);
      } catch (error) {
        if (!this.disposed && request.revision === this.revision) this.reject(error);
      }
    }
    this.running = false;
  }
}
