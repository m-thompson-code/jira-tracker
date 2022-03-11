import {
  Component,
  ViewChild,
  ElementRef,
  Output,
  EventEmitter
} from '@angular/core';

export interface UploadFile {
  file: File;
  filename: string;
}

@Component({
  selector: 'app-uploader',
  templateUrl: './uploader.component.html',
  styleUrls: ['./uploader.component.scss'],
})
export class UploaderComponent {
  @ViewChild('input', { static: true }) private input!: ElementRef<HTMLInputElement>;

  dragover?: boolean;

  @Output() filesUploaded: EventEmitter<FileList> = new EventEmitter();


  private handleFileList(fileList: FileList): void {
    this.filesUploaded.emit(fileList);

    // Clear input value to allow for same file upload
    this.input.nativeElement.value = '';
  }

  handleFileInputChange(event: Event): void {
    const target = event?.target as HTMLInputElement;
    const files = target.files;

    if (!files) {
      console.warn("Unexpected missing files");
      return;
    }

    if (!files.length) {
      return;
    }

    this.handleFileList(files);
  }

  handleFileInputDrop(event: DragEvent): void {
    event?.stopPropagation();
    event?.preventDefault();

    const dataTransfer = event?.dataTransfer;

    if (!dataTransfer) {
      console.warn("Unexpected missing DataTransfer");
      return;
    }

    if (!dataTransfer?.files.length) {
      return;
    }

    if (!dataTransfer.files?.length) {
      console.error('Unexpected missing DataTransfer files from event');
      return;
    }

    const files = dataTransfer.files;

    this.handleFileList(files);

    this.dragover = false;
  }

  handleDragover(event: any): void {
    event?.stopPropagation();
    event?.preventDefault();

    if (!event?.dataTransfer) {
      return;
    }

    // Style the drag-and-drop as a "copy file" operation.
    event.dataTransfer.dropEffect = 'copy';

    this.dragover = true;
  }

  handleDragend(event: any): void {
    event?.stopPropagation();
    event?.preventDefault();

    this.dragover = false;
  }
}
