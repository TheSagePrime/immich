export type UploadDropTarget = {
  label: string;
  writable: boolean;
  libraryId?: string;
  folderPath?: string;
  destination?: string;
};

export type UploadDropTargetProvider = {
  page: () => UploadDropTarget | undefined;
  card: (path: string) => UploadDropTarget | undefined;
};

export type UploadDropTargetMatch = {
  target: UploadDropTarget;
  cardPath?: string;
};

export class UploadDropTargetManager {
  hoveredCardPath = $state<string>();
  private provider?: UploadDropTargetProvider;

  register(provider: UploadDropTargetProvider) {
    this.provider = provider;
    return () => {
      if (this.provider === provider) {
        this.provider = undefined;
        this.hoveredCardPath = undefined;
      }
    };
  }

  find(element: Element | null, fallback?: UploadDropTarget): UploadDropTargetMatch | undefined {
    const cardPath = element?.closest<HTMLElement>('[data-folder-path]')?.dataset.folderPath;
    const cardTarget = cardPath ? this.provider?.card(cardPath) : undefined;
    if (cardPath && cardTarget) {
      return { target: cardTarget, cardPath };
    }

    const pageTarget = this.provider?.page() ?? fallback;
    return pageTarget ? { target: pageTarget } : undefined;
  }

  hover(match?: UploadDropTargetMatch) {
    this.hoveredCardPath = match?.target.writable ? match.cardPath : undefined;
  }
}

export const uploadDropTargetManager = new UploadDropTargetManager();
