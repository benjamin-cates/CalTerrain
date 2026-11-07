
import urllib.request

# California geographic bounding box range
lat_start, lat_end = 32, 43
lon_start, lon_end = 114, 125

print('Generating California tile URLs and starting download...')

for lat in range(lat_start, lat_end):
    for lon in range(lon_start, lon_end):
        tile_id = f'n{lat}w{lon}'
        path = f'StagedProducts/Elevation/1/TIFF/current/{tile_id}/USGS_1_{tile_id}.tif'
        download_url = f'https://prd-tnm.s3.amazonaws.com/{path}'
        file_name = f'USGS_1_{tile_id}.tif'
        
        try:
            # Check if file exists by sending a quick request head/open
            req = urllib.request.Request(download_url)
            with urllib.request.urlopen(req) as response:
                print(f'Downloading {file_name}...')
                urllib.request.urlretrieve(download_url, file_name)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                # Expected for ocean tiles or grids outside the precise CA border
                continue
            print(f'Error downloading {file_name}: {e}')
        except Exception as e:
            print(f'Error: {e}')